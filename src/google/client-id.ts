/** The OAuth client of the user's own Google Cloud project ("Desktop app" type); FalaTrace ships none. */
export const GOOGLE_CLIENT_ID = /^[0-9]{6,30}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$/;
export const isGoogleClientId = (value: unknown): value is string => typeof value === "string" && GOOGLE_CLIENT_ID.test(value);
