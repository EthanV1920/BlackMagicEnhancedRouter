import type { LockState, VideohubSnapshot } from "@blackmagic-enhanced-router/shared";

type MatrixGridProps = {
  snapshot: VideohubSnapshot;
  disabled: boolean;
  onRoute: (output: number, input: number) => void;
};

const getPortName = (label: string | undefined, fallbackPrefix: "In" | "Out", index: number) => ({
  label: label?.trim() || `${fallbackPrefix} ${index + 1}`,
  meta: `${fallbackPrefix} ${index + 1}`,
});

const getRouteForOutput = (snapshot: VideohubSnapshot, outputIndex: number) =>
  snapshot.routes.find((route) => route.output === outputIndex)?.input;

const getLockForOutput = (snapshot: VideohubSnapshot, outputIndex: number): LockState =>
  snapshot.outputLocks.find((lock) => lock.output === outputIndex)?.state ?? "U";

const getLockLabel = (lockState: LockState) => {
  if (lockState === "L") {
    return "Locked remotely";
  }
  if (lockState === "O") {
    return "Locked by this client";
  }
  return "Unlocked";
};

export function MatrixGrid({ snapshot, disabled, onRoute }: MatrixGridProps) {
  const inputCount = snapshot.device.videoInputs ?? snapshot.inputs.length;
  const outputCount = snapshot.device.videoOutputs ?? snapshot.outputs.length;
  const inputs = Array.from({ length: inputCount }, (_, index) => {
    const label = snapshot.inputs.find((entry) => entry.index === index)?.name;
    return { index, ...getPortName(label, "In", index) };
  });
  const outputs = Array.from({ length: outputCount }, (_, index) => {
    const label = snapshot.outputs.find((entry) => entry.index === index)?.name;
    return { index, ...getPortName(label, "Out", index) };
  });

  if (inputCount === 0 || outputCount === 0 || !snapshot.connection.ready) {
    return (
      <div className="matrix-loading" data-testid="matrix-loading">
        <div className="matrix-loading__card">
          <span className="matrix-loading__eyebrow">Awaiting device state</span>
          <h2>Matrix grid will appear after the Videohub sends its full routing snapshot.</h2>
        </div>
      </div>
    );
  }

  return (
    <div className="matrix-shell">
      <div className="matrix-scroll">
        <table className="matrix-table">
          <thead>
            <tr>
              <th className="matrix-corner">Outputs / Inputs</th>
              {inputs.map((input) => (
                <th className="matrix-header" key={input.index} scope="col">
                  <div className="matrix-header__content">
                    <span className="matrix-header__label">{input.label}</span>
                    <small className="matrix-header__meta">{input.meta}</small>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {outputs.map((output) => {
              const activeInput = getRouteForOutput(snapshot, output.index);
              const lockState = getLockForOutput(snapshot, output.index);
              const rowIsPending = snapshot.pendingRoute?.output === output.index;
              const rowPendingStatus =
                rowIsPending ? snapshot.pendingRoute?.status : undefined;
              const rowDisabled =
                disabled || (rowPendingStatus !== undefined && rowPendingStatus !== "ambiguous") || lockState === "L";

              return (
                <tr
                  className={`matrix-row ${rowDisabled ? "matrix-row--disabled" : ""} ${
                    rowPendingStatus === "ambiguous" ? "matrix-row--ambiguous" : ""
                  }`}
                  key={output.index}
                >
                  <th className="matrix-row__header" scope="row">
                    <span>{output.label}</span>
                    <small>{output.meta}</small>
                    <em className={`lock lock--${lockState.toLowerCase()}`}>{getLockLabel(lockState)}</em>
                  </th>
                  {inputs.map((input) => {
                    const isActive = activeInput === input.index;
                    const isPendingTarget =
                      rowIsPending && snapshot.pendingRoute?.input === input.index;

                    return (
                      <td key={`${output.index}-${input.index}`}>
                        <button
                          aria-label={`Route ${output.meta} to ${input.meta}`}
                          className={[
                            "crosspoint",
                            isActive ? "crosspoint--active" : "",
                            isPendingTarget ? "crosspoint--pending" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          disabled={rowDisabled}
                          onClick={() => onRoute(output.index, input.index)}
                          type="button"
                        >
                          <span className="crosspoint__dot" />
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
