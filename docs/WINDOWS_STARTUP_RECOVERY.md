# Recover startup after an older Windows update

If Inertia reports that **prior process cleanup remains unconfirmed**, an older
update may have left a runtime lock without its cleanup record. Reinstalling the
application preserves your profile, including that lock.

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

This is recovery for a profile already affected by an older update. The fixed
installer and cleanup transaction are tested to update a healthy installation
without requiring a Windows restart.
