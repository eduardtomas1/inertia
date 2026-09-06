# Recover startup after an older Windows update

If Inertia reports that **prior process cleanup remains unconfirmed**, an older
update may have left a runtime lock without its cleanup record. A failed command
launch in older builds could also write an invalid zero-PID ownership record.
Reinstalling preserves your profile, including its recovery records.

The corrected Windows runtime keeps failed launches readable and automatically
repairs the precisely identified historical zero-PID records. It still verifies
the recorded Windows Job before admitting new work. This repair preserves
projects, messages and attachments and does not require a restart when that
native cleanup can be confirmed. See the investigation in
[#282](https://github.com/eduardtomas1/inertia/issues/282).

For an older bare runtime lock, or when exact native cleanup remains unavailable:

1. Save work in your other applications and close Inertia.
2. Choose **Start → Power → Restart** in Windows.
3. Open Inertia again. It verifies that Windows has started a new boot session
   before retiring records from the previous session. Saved projects, messages,
   and attachments remain in place; an unfinished turn is marked interrupted.
4. If startup remains blocked, open **Settings → Lifecycle Integrity** and copy
   the support summary for investigation.

Windows Restart performs a full boot cycle. Fast Startup can retain kernel state
through an ordinary shutdown, so use the explicit Restart action for this
recovery. See Microsoft's [system power states documentation](https://learn.microsoft.com/en-us/windows/win32/power/system-power-states).

Do not delete the profile, database, or runtime journal files to remove this
message. When Inertia cannot verify the boot identity or its ownership records,
it preserves the lock and your work.

An unknown or malformed record cannot be repaired merely by restarting Windows;
include the support summary if the warning persists. Do not repeatedly reinstall
or remove the profile to suppress it.

Windows installation also requires the old app to finish closing. A closed
window is not proof that its background runtime has exited. Setup refuses to
overwrite live installed processes; affected-profile recovery, a new turn, and
complete process exit are exercised by the installed-upgrade smoke test.

After its normal shutdown work has drained, the Windows runtime also fences its
process writer before checking final cleanup. Late callbacks cannot admit a new
child after the runtime reports that it has stopped. If that fence or the final
cleanup proof fails, Inertia retains the recovery evidence instead of allowing
the installer to overwrite an unconfirmed runtime.
