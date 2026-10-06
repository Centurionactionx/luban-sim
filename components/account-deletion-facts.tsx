/**
 * What deleting an account removes and what it keeps, shared by the in-app
 * confirmation and the public /delete-account page so both always say the
 * same thing. Keep in step with deleteOwnAccount() in
 * lib/server/account-management.ts and DELETE /api/account.
 */

export const DELETED_ITEMS = [
  "Your name and email address in the Market Lab.",
  "Your sign-in: password, second factors, every signed-in device, and push-notification registrations.",
  "Your seat on your team, and any unused invitations you created.",
  "Feedback you sent from the app.",
] as const;

export const KEPT_ITEMS = [
  "Trades you placed stay on your team's ledger so its cash and holdings still add up. Teammates and hosts see them as made by “Deleted user”, with no name or email.",
  "Your team's portfolio, watchlist, and activity feed, which belong to the team. Feed entries written before you left keep their original wording, which may include the name you used then.",
  "The security log of account events, such as when your account was created and deleted. The deletion entry has no name or email; entries written earlier may include them.",
] as const;

export function AccountDeletionFacts({ className }: { className?: string }) {
  return (
    <div className={className}>
      <h3>Deleted</h3>
      <ul>
        {DELETED_ITEMS.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <h3>Kept</h3>
      <ul>
        {KEPT_ITEMS.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
