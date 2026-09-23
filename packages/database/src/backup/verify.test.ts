import { createKeyring, type Keyring } from "@wayscribe/payload-security";
import { expect, it, vi } from "vitest";
const { restore } = vi.hoisted(() => ({ restore: vi.fn() }));
vi.mock("./restore.js", () => ({ withRestoredDatabase: restore }));
import { verifyBackup } from "./verify.js";
import { BackupError } from "./connection.js";
const options = {
  databaseUrl: "unused",
  input: "unused",
  timeoutMs: 30_000,
  keyring: createKeyring("synthetic_backup_key_123456789012345")
};
it("requires key material before any restore resources", async () => {
  restore.mockClear();
  await expect(
    verifyBackup({ ...options, keyring: undefined as unknown as Keyring })
  ).rejects.toMatchObject({ code: "keys_required" });
  expect(restore).not.toHaveBeenCalled();
});
it("sanitizes inspector failures while preserving only validated ownership metadata", async () => {
  restore.mockRejectedValueOnce(
    Object.assign(new Error("SECRET database row"), {
      cleanupDatabase: "wayscribe_restore_check_abc",
      uncertainDatabase: "secret\nvalue"
    })
  );
  await expect(verifyBackup(options)).rejects.toMatchObject({
    code: "inspection_failed",
    message: "inspection_failed",
    cleanupDatabase: "wayscribe_restore_check_abc",
    uncertainDatabase: undefined
  });
});
it("preserves safe lifecycle codes and unknown CREATE metadata", async () => {
  const error = new BackupError("create_outcome_unknown");
  error.uncertainDatabase = "wayscribe_restore_check_abc";
  restore.mockRejectedValueOnce(error);
  await expect(verifyBackup(options)).rejects.toMatchObject({
    code: "create_outcome_unknown",
    uncertainDatabase: "wayscribe_restore_check_abc"
  });
});
