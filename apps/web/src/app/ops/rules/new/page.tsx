import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { currentActor } from '../../../../server/session';
import { readNewRulePage } from '../../../../composition/ops-rules';
import { EnvLabel } from '../../../../ui/EnvLabel';
import { PageHeader, Section } from '../../../../ui/publisher/kit';
import { FORM_HEADING, MFA_NOTICE, RULES_BACK_LINK } from '../../../../lib/ops-rules-copy';
import { RuleForm } from '../RuleForm';
import '../../pk-opshome.css';

export const metadata: Metadata = { title: FORM_HEADING };

// BR-6: the form that adds one setting. The page only reads (the rule list, a start time, a single-use
// Idempotency-Key); the form posts to POST /api/ops/rules, the BR-2 route, which checks the second factor, the
// registry range and the scope id again. A session without the authenticator code is told so before it types.
export default async function OpsRulesNew() {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/rules/new');
  const read = await readNewRulePage(actor);
  if (read === null) redirect('/signin?next=/ops/rules/new');
  return (
    <>
      <PageHeader title={FORM_HEADING} aside={<EnvLabel environment={read.environment} />} />
      <p>
        <Link href="/ops/rules">{RULES_BACK_LINK}</Link>
      </p>
      <Section title={FORM_HEADING} id="rules-new">
        {read.mfa ? null : (
          <p role="note" data-testid="rules-mfa-notice">
            {MFA_NOTICE}
          </p>
        )}
        <RuleForm
          rules={read.rules}
          idempotencyKey={read.key}
          defaultFrom={read.default_from}
          hasCode={read.mfa}
        />
      </Section>
    </>
  );
}
