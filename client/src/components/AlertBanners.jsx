/** Actionable alert banners driven by the server's alerts service. */
import { Banner, Button } from './ui.jsx';

const ACTION_LABELS = {
  profile: 'Open profile',
  installments: 'View installments',
  wallet: 'Open wallet',
  support: 'Open inquiry',
};

export function AlertBanners({ alerts, onAction, limit = 6 }) {
  const items = (alerts?.items ?? []).slice(0, limit);
  if (!items.length) return null;
  return (
    <div className="banners">
      {items.map((item) => (
        <Banner
          key={item.key}
          tone={item.tone === 'muted' ? 'ok' : item.tone}
          title={item.title}
          action={
            item.action && onAction ? (
              <Button className="sm" onClick={() => onAction(item.action)}>
                {ACTION_LABELS[item.action] ?? 'View'}
              </Button>
            ) : null
          }
        >
          {item.message}
        </Banner>
      ))}
    </div>
  );
}
