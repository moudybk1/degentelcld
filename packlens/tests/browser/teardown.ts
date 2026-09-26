import { rmSync } from "node:fs";

/** Remove the temporary fixture database (and its WAL files) created for this run. */
export default function teardown(): void {
  const db = process.env.PACKLENS_E2E_DB;
  if (!db) return;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${db}${suffix}`, { force: true });
}
