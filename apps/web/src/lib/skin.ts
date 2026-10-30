// The two skins (SKIN-A, decisions 38 to 41). Each skin is one fixed palette in globals.css, chosen by
// the um_skin cookie on the server so the first paint is right. Bright Market is the default: any
// value other than the exact string `harbour` renders market (decision 39).
export const SKINS = ['market', 'harbour'] as const;
export type Skin = (typeof SKINS)[number];

export const SKIN_COOKIE = 'um_skin';
export const SKIN_COOKIE_MAX_AGE_S = 180 * 24 * 60 * 60;

export function skinFromCookie(value: string | undefined): Skin {
  return value === 'harbour' ? 'harbour' : 'market';
}

// The one cookie the Appearance route sets: no session data, no id, only the skin name.
export function skinSetCookie(skin: Skin): string {
  return `${SKIN_COOKIE}=${skin}; Path=/; Max-Age=${SKIN_COOKIE_MAX_AGE_S}; SameSite=Lax; Secure; HttpOnly`;
}
