/**
 * Locate the Azurite table emulator and build a connection string for it.
 *
 * There are two right answers depending on where the test runs, which is why this
 * probes instead of hardcoding: inside the devcontainer Azurite is the
 * docker-compose service `azurite`, and from the host it is the published port on
 * `127.0.0.1`. Getting this wrong produces a confusing SDK connection error rather
 * than "the emulator is not running", so the failure message matters as much as
 * the lookup.
 *
 * Must be called *before* importing `src/storage.js`, which builds its TableClient
 * at import time from `process.env`.
 *
 * Note that replacing `globalThis.fetch` to fake Discord and ScoutNet does *not*
 * disturb storage: the Table Storage SDK talks through node's `http` module, not
 * through global fetch. That is why the tests can stub it wholesale.
 */

const CANDIDATES = ["azurite:10002", "127.0.0.1:10002", "localhost:10002"];
const DEV_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

function connectionStringFor(host) {
  return (
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
    `AccountKey=${DEV_KEY};` +
    `TableEndpoint=http://${host}/devstoreaccount1;`
  );
}

/** True if something answers on the table endpoint. 403 counts: unsigned but alive. */
async function reachable(host) {
  try {
    const res = await fetch(`http://${host}/devstoreaccount1/Tables`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Point `process.env` at a reachable emulator and return the table name used.
 *
 * `AZURITE_TABLE_HOST` overrides the probe. Exits with instructions rather than
 * letting every case fail separately — one clear line beats a dozen stack traces.
 */
export async function useAzurite(tablePrefix) {
  const hosts = process.env.AZURITE_TABLE_HOST
    ? [process.env.AZURITE_TABLE_HOST]
    : CANDIDATES;

  for (const host of hosts) {
    if (await reachable(host)) {
      process.env.TABLE_CONNECTION_STRING = connectionStringFor(host);
      // A fresh table per run, so cases never inherit another run's rows.
      process.env.TABLE_NAME = `${tablePrefix}${Date.now().toString().slice(-8)}`;
      return { host, table: process.env.TABLE_NAME };
    }
  }

  console.error(
    `\nCannot reach the Azurite table emulator (tried ${hosts.join(", ")}).\n\n` +
      "  docker compose up -d azurite\n" +
      "  npm run test:integration\n\n" +
      "Set AZURITE_TABLE_HOST=host:port if it runs somewhere else.\n",
  );
  process.exit(1);
}
