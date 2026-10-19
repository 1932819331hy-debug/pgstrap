import * as zg from "zapatos/generate"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createRequire } from "node:module"
import {
  getConnectionStringFromEnv,
  getPgConnectionFromEnv,
} from "pg-connection-from-env"
import { Context } from "./get-project-context"
import { dumpTree } from "pg-schema-dump"
import path from "path"
import { migrate } from "./migrate"

const dumpTreeModulePath = createRequire(__filename).resolve("pg-schema-dump")

const dumpTreeWithConnection = async (
  options: Parameters<typeof dumpTree>[0],
  connectionString: string,
) => {
  const script = `const dumpTree = require(process.argv[1]).dumpTree;
dumpTree(JSON.parse(process.argv[2])).catch((error) => {
  console.error(error)
  process.exit(1)
})`

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-e", script, dumpTreeModulePath, JSON.stringify(options)],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          POSTGRES_URI: connectionString,
          PG_URI: connectionString,
          DATABASE_URL: connectionString,
        },
        stdio: "inherit",
      },
    )

    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`pg-schema-dump exited with ${signal ?? code}`))
    })
  })
}

export const generate = async ({
  schemas,
  defaultDatabase,
  dbDir,
  pglite = false,
  migrationsDir,
}: Pick<Context, "schemas" | "defaultDatabase" | "dbDir"> & {
  pglite?: boolean
  migrationsDir?: string
}) => {
  dbDir = dbDir ?? "./src/db"
  migrationsDir = migrationsDir ?? path.join(dbDir, "migrations")

  if (pglite) {
    const { PGlite } = await import("@electric-sql/pglite")
    const { fromNodeSocket } = await import("pg-gateway/node")
    const net = await import("node:net")

    const db = new PGlite()
    const gatewayPassword = randomBytes(24).toString("hex")

    await migrate({
      client: db as any,
      migrationsDir,
      defaultDatabase,
      cwd: process.cwd(),
      schemas,
    })

    const server = net.createServer(async (socket) => {
      const connection = await fromNodeSocket(socket, {
        serverVersion: "16.3 (PGlite)",
        auth: {
          method: "password",
          validateCredentials: ({ username, password }: any) =>
            username === "postgres" && password === gatewayPassword,
          getClearTextPassword: () => gatewayPassword,
        },
        async onStartup() {
          await (db as any).waitReady
        },
        async onMessage(data: Uint8Array, { isAuthenticated }: any) {
          if (!isAuthenticated) return
          try {
            const { data: responseData } = await (db as any).execProtocol(data)
            return responseData
          } catch {
            return undefined
          }
        },
      })
    })

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as any).port
    const connectionString = `postgres://postgres:${gatewayPassword}@127.0.0.1:${port}/postgres`

    try {
      await zg.generate({
        db: {
          connectionString,
        },
        schemas: Object.fromEntries(
          schemas.map((s) => [s, { include: "*", exclude: [] }]),
        ),
        outDir: dbDir,
      })

      await dumpTreeWithConnection(
        {
          targetDir: path.join(dbDir, "structure"),
          defaultDatabase: "postgres",
          schemas,
        },
        connectionString,
      )
    } finally {
      server.close()
    }
    return
  }

  await zg.generate({
    db: {
      connectionString: getConnectionStringFromEnv({
        fallbackDefaults: {
          database: defaultDatabase,
        },
      }),
    },
    schemas: Object.fromEntries(
      schemas.map((s) => [
        s,
        {
          include: "*",
          exclude: [],
        },
      ]),
    ),
    outDir: dbDir,
  })

  await dumpTree({
    targetDir: path.join(dbDir, "structure"),
    defaultDatabase,
    schemas,
  })
}
