import { LogIn } from "lucide-react";

type Props = {
  ssoUrl: string;
};

export function LoginScreen({ ssoUrl }: Props) {
  return (
    <div className="fullpage-screen">
      <div className="fullpage-screen-content">
        <div className="fullpage-screen-icon">
          <LogIn size={40} aria-hidden="true" />
        </div>
        <h1 className="fullpage-screen-title">Sign In</h1>
        <p className="fullpage-screen-body">
          You must be signed in to access the DevOps Portal.
        </p>
        {ssoUrl ? (
          <a href={ssoUrl} className="primary" style={{ textDecoration: "none" }}>
            <LogIn size={16} aria-hidden="true" />
            Sign in with SSO
          </a>
        ) : (
          <p className="fullpage-screen-hint">Contact your administrator to configure SSO access.</p>
        )}
      </div>
    </div>
  );
}
