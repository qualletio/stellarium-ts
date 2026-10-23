export const SITE_NAME = 'Stellarium Platform';

export const SITE_DESCRIPTION = 'Manage your Stellarium organization: prepaid balance, usage, nodes and payouts.';

export const DOCS_URL = 'https://docs.stellarium.sh';

/** Whether to offer GitHub sign-in. Set GITHUB_SIGN_IN=true when the operator has GitHub OAuth credentials. Server only. */
export const githubSignIn = () => process.env.GITHUB_SIGN_IN === 'true';
