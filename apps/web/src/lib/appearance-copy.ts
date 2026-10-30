// Words of the Appearance control in the footer (SKIN-A). No dash characters and no italics in copy.
import type { Skin } from './skin';

export const APPEARANCE_LEGEND = 'Appearance';
export const SKIN_LABELS: Record<Skin, string> = {
  market: 'Bright Market',
  harbour: 'Deep Harbour',
};
export const APPEARANCE_SAVING = 'Saving your choice';
export const APPEARANCE_SAVE_FAILED = 'We could not save your choice. Please try again.';

// FIX-FLOW D8: said in the status region after a choice, so a screen reader hears the change.
export const appearanceApplied = (label: string): string => `Appearance changed to ${label}.`;
