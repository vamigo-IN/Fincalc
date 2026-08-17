/**
 * REMOVED. This file is a tombstone and should be deleted:
 *
 *   git rm server/scripts/reset-admin.ts
 *
 * It used to create or reset the admin password from the command line. That
 * meant shell access to the container — or to a checkout with DATABASE_URL —
 * was enough to take over the account that can read every user's financial
 * data, without ever knowing the existing password.
 *
 * It is no longer compiled into the runtime image (tsconfig.build.json), the
 * `reset-admin` npm script is gone, and the seed no longer creates accounts.
 * The stub remains only because the deletion could not be completed in the same
 * pass; it refuses to run so that an unpruned checkout is not a live bypass.
 *
 * WHAT TO USE INSTEAD
 *   Change a password:  sign in, go to /admin/account, enter the current one.
 *   First admin on a fresh database:  the one-time SQL in DEPLOY.md.
 *   Lost password:      the UPDATE statement in DEPLOY.md, which needs database
 *                       access — deliberately a higher bar than a script.
 */
console.error(
  [
    '',
    'reset-admin has been removed.',
    '',
    '  Change an admin password:  sign in and use /admin/account',
    '                             (requires the current password)',
    '  Create the first admin:    see "The admin account" in DEPLOY.md',
    '',
    'This file is a tombstone. Delete it:  git rm server/scripts/reset-admin.ts',
    '',
  ].join('\n'),
)
process.exit(1)
