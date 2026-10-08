import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <div className="auth-wrap">
      <div className="auth-card center">
        <h1>Page not found</h1>
        <p className="muted">The page you asked for does not exist or was moved.</p>
        <Link className="btn primary" to="/">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
