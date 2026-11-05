// INT-CTL / CTL.7: the words of the exposure screen. Pure: it takes the api_exposure rows as stored and gives one
// line per group. A seeded row (still stamped with the epoch) was never changed, so it has no last change. The name
// of the operator shows only on a session with the second factor; without it the screen says "an operator".
import { API_GROUPS, SEED_EPOCH } from '@umsbx/contracts';
import type { ApiGroup } from '@umsbx/contracts';
import type { ExposureRow } from '../server/access';

export const EXPOSURE_LABELS: Record<ApiGroup, string> = {
  catalogue: 'Catalogue, briefs and offers',
  orders: 'Orders, quotes and approvals',
  library: 'Library',
  mandates: 'Mandates',
  webhooks: 'Webhook subscriptions',
  seller: 'Seller reports',
  ops: 'Operator API',
  mcp: 'MCP server, all tools',
  'mcp:search_catalogue': 'MCP tool: search catalogue',
  'mcp:get_offer': 'MCP tool: get offer',
  'mcp:propose_pack': 'MCP tool: propose pack',
  'mcp:open_unit': 'MCP tool: open unit',
  'mcp:check_budget': 'MCP tool: check budget',
  'mcp:buy_unit': 'MCP tool: buy unit',
};

export interface ExposureLine {
  group: ApiGroup;
  label: string;
  state: 'on' | 'off';
  last_change: { by: string; at: string; reason_code: string | null } | null;
  toggle: { action: 'on' | 'off'; needs_mfa: boolean; path: string };
}

const EPOCH_MS = new Date(SEED_EPOCH).getTime();

export function exposureView(rows: readonly ExposureRow[], o: { mfa: boolean }): ExposureLine[] {
  const byGroup = new Map(rows.map((r) => [r.group_name, r]));
  const lines: ExposureLine[] = [];
  for (const group of API_GROUPS) {
    const row = byGroup.get(group);
    // A missing row is shown as off: the reader closes a group it cannot find.
    const enabled = row?.enabled ?? false;
    const never = row !== undefined && new Date(row.changed_at).getTime() <= EPOCH_MS;
    const action = enabled ? 'off' : 'on';
    lines.push({
      group,
      label: EXPOSURE_LABELS[group],
      state: enabled ? 'on' : 'off',
      last_change:
        row === undefined || never
          ? null
          : {
              by: o.mfa && row.changed_by !== null ? row.changed_by : 'an operator',
              at: row.changed_at,
              reason_code: row.reason_code,
            },
      toggle: {
        action,
        needs_mfa: action === 'on',
        path: `/api/ops/api-exposure/${encodeURIComponent(group)}/${action}`,
      },
    });
  }
  return lines;
}
