import { AlertTriangle, RefreshCcw } from "lucide-react";

type Props = {
  message: string;
  onRetry: () => void;
};

export function ErrorScreen({ message, onRetry }: Props) {
  return (
    <div className="fullpage-screen">
      <div className="fullpage-screen-content">
        <div className="fullpage-screen-icon error">
          <AlertTriangle size={40} aria-hidden="true" />
        </div>
        <h1 className="fullpage-screen-title">Something went wrong</h1>
        <p className="fullpage-screen-body">{message}</p>
        <button className="primary" onClick={onRetry}>
          <RefreshCcw size={16} aria-hidden="true" />
          Try again
        </button>
      </div>
    </div>
  );
}
