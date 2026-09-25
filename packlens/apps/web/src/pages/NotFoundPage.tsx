import { Link } from "react-router";
import { useNsHref } from "../state/namespace";

export function NotFoundPage() {
  const href = useNsHref();
  return (
    <div className="container">
      <div className="eyebrow">404</div>
      <h1 className="display">
        Nothing here <em>to investigate.</em>
      </h1>
      <p className="lede">This page does not exist.</p>
      <p style={{ marginTop: 24 }}>
        <Link className="btn primary" to={href("/")}>
          Back to Pack Radar
        </Link>
      </p>
    </div>
  );
}
