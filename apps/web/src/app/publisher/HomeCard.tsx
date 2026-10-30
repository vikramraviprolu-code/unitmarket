import Link from 'next/link';

// A whole-card link of the publisher home. The link is named by its title alone and described by its line, so
// a screen reader and a test find "Your offers" as the link name (the kit ActionCard folds the line into the name).
export function HomeCard({
  href,
  title,
  body,
  slug,
}: {
  href: string;
  title: string;
  body: string;
  slug: string;
}) {
  const titleId = `card-${slug}-title`;
  const bodyId = `card-${slug}-body`;
  return (
    <Link
      className="pk-card"
      href={href}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-testid={`publisher-card-${slug}`}
    >
      <span className="pk-card-title" id={titleId}>
        {title}
      </span>
      <span className="pk-card-body" id={bodyId}>
        {body}
      </span>
    </Link>
  );
}
