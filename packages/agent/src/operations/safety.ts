import { settingsComplaints } from '@nortuscc/profile-engine';

// Public owner identities are exact, bounded, and subject to the setting owner's secret checks.
export const safeOwnerString = (value: string): boolean => value.length > 0 && [...value].length <= 500 && !settingsComplaints({ value }).length;
