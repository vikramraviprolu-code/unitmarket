// TEMP-until-lane-01: local copy of the F1 interface text from docs/design/lanes/01-contracts.md.
// Lane 01 owns @umsbx/contracts. Replace these imports with `from "@umsbx/contracts"` once F1 is on main, then delete this file.

export type Id = string;
export type IsoUtc = string;
export interface Clock {
  now(): Date;
}
export type IdPrefix =
  | 'ord'
  | 'unt'
  | 'pvo'
  | 'opr'
  | 'ent'
  | 'apr'
  | 'quo'
  | 'lnk'
  | 'aev'
  | 'led'
  | 'rct'
  | 'cas'
  | 'cac'
  | 'rfr'
  | 'brf'
  | 'prp'
  | 'pub'
  | 'art'
  | 'ofr'
  | 'buy'
  | 'ses'
  | 'alr'
  | 'pcl'
  | 'whk'
  | 'aud'
  | 'oap';
export interface Ids {
  next(prefix: IdPrefix): Id;
  nonce(): string;
}
