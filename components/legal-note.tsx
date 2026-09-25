const SITE_URL = "https://lubancanada.com";

/**
 * Disclaimer and policy links shown wherever someone signs in, signs up, or
 * accepts an invitation. The policies live on the public site.
 */
export function LegalNote() {
  return (
    <p className="legal-note">
      All trading uses simulated money, for education only. Nothing here is
      investment advice. By continuing you agree to the{" "}
      <a href={`${SITE_URL}/terms`}>contest rules</a> and{" "}
      <a href={`${SITE_URL}/privacy`}>privacy policy</a>.
    </p>
  );
}
