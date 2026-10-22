// Conformance suite P1 to P15 and dry-run scenarios D1 to D6 against the dry-run transport (A-24).
import { describeDryRunOnly, describePayPalConformance, dryRunSubject } from '@umsbx/testkit';

const subject = dryRunSubject();
describePayPalConformance(subject);
describeDryRunOnly(subject);
