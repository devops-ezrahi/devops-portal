import { ShieldOff } from "lucide-react";

export function AccessDeniedScreen() {
  return (
    <div className="fullpage-screen">
      <div className="fullpage-screen-content">
        <div className="fullpage-screen-icon access-denied">
          <ShieldOff size={40} aria-hidden="true" />
        </div>
        <h1 className="fullpage-screen-title">Access Denied</h1>
        <p className="fullpage-screen-body">
          Your account doesn't have permission to access this portal.
        </p>
        <p className="fullpage-screen-hint">
          Contact your administrator to request access.
        </p>
      </div>
    </div>
  );
}
