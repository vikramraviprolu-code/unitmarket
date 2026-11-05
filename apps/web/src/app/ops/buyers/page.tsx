import { redirect } from 'next/navigation';

// INT-OPS-A / OPS-A.5: the Buyers tab opens on the case queue, the only buyer page of the operator so far.
export default function OpsBuyers() {
  redirect('/ops/buyers/cases');
}
