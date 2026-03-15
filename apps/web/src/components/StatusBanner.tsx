import type { VideohubSnapshot } from "@blackmagic-enhanced-router/shared";

type StatusBannerProps = {
  hasSelection: boolean;
  snapshot: VideohubSnapshot;
};

export function StatusBanner({ hasSelection, snapshot }: StatusBannerProps) {
  if (!hasSelection) {
    return (
      <div className="status-banner status-banner--info">
        Add or select a saved router to start the routing session.
      </div>
    );
  }

  if (snapshot.device.devicePresent === false && snapshot.connection.state === "connected") {
    return (
      <div className="status-banner status-banner--warning">
        The Videohub server is reachable, but no compatible device is currently attached.
      </div>
    );
  }

  if (snapshot.device.devicePresent === "needs_update") {
    return (
      <div className="status-banner status-banner--warning">
        The Videohub reports incompatible firmware. Update the device before routing.
      </div>
    );
  }

  if (snapshot.connection.state === "error") {
    return (
      <div className="status-banner status-banner--error">
        {snapshot.connection.error ?? "The Videohub session failed."}
      </div>
    );
  }

  if (snapshot.connection.state === "degraded") {
    return (
      <div className="status-banner status-banner--warning">
        Connection is degraded. The backend is still connected but has not seen recent protocol traffic.
      </div>
    );
  }

  if (snapshot.connection.state === "connecting") {
    return (
      <div className="status-banner status-banner--info">
        Connecting to the Videohub and waiting for the initial status dump.
      </div>
    );
  }

  if (snapshot.connection.state === "disconnected") {
    return (
      <div className="status-banner status-banner--warning">
        Disconnected from the Videohub. Use reconnect after selecting a router.
      </div>
    );
  }

  return null;
}
