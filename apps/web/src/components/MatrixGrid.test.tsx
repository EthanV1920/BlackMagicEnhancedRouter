import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { VideohubSnapshot } from "@blackmagic-enhanced-router/shared";

import { MatrixGrid } from "./MatrixGrid";
import { StatusBanner } from "./StatusBanner";

const baseSnapshot: VideohubSnapshot = {
  connection: {
    state: "connected",
    ready: true,
  },
  device: {
    protocolVersion: "2.3",
    devicePresent: true,
    modelName: "Blackmagic Smart Videohub",
    videoInputs: 2,
    videoOutputs: 2,
  },
  inputs: [
    { index: 0, name: "Camera 1" },
    { index: 1, name: "Camera 2" },
  ],
  outputs: [
    { index: 0, name: "Program" },
    { index: 1, name: "Multiview" },
  ],
  routes: [
    { output: 0, input: 0 },
    { output: 1, input: 1 },
  ],
  outputLocks: [
    { output: 0, state: "U" },
    { output: 1, state: "L" },
  ],
};

afterEach(() => {
  cleanup();
});

describe("MatrixGrid", () => {
  it("renders row and column labels with active crosspoints", () => {
    render(<MatrixGrid disabled={false} onRoute={vi.fn()} snapshot={baseSnapshot} />);

    expect(screen.getByText("Camera 1")).toBeInTheDocument();
    expect(screen.getByText("Program")).toBeInTheDocument();
    expect(screen.getByLabelText("Route Out 1 to In 1")).toHaveClass("crosspoint--active");
  });

  it("calls onRoute when clicking an unlocked crosspoint", () => {
    const onRoute = vi.fn();
    render(<MatrixGrid disabled={false} onRoute={onRoute} snapshot={baseSnapshot} />);

    fireEvent.click(screen.getByLabelText("Route Out 1 to In 2"));
    expect(onRoute).toHaveBeenCalledWith(0, 1);
  });

  it("disables locked rows", () => {
    render(<MatrixGrid disabled={false} onRoute={vi.fn()} snapshot={baseSnapshot} />);

    expect(screen.getByLabelText("Route Out 2 to In 1")).toBeDisabled();
  });

  it("shows pending route styling", () => {
    render(
      <MatrixGrid
        disabled={false}
        onRoute={vi.fn()}
        snapshot={{
          ...baseSnapshot,
          pendingRoute: {
            output: 0,
            input: 1,
            requestedAt: new Date().toISOString(),
            status: "awaiting_confirmation",
          },
        }}
      />,
    );

    expect(screen.getByLabelText("Route Out 1 to In 2")).toHaveClass("crosspoint--pending");
  });
});

describe("StatusBanner", () => {
  it("renders disconnected and firmware states", () => {
    const { rerender } = render(<StatusBanner hasSelection={false} snapshot={baseSnapshot} />);
    expect(screen.getByText(/Add or select a saved router/)).toBeInTheDocument();

    rerender(
      <StatusBanner
        hasSelection
        snapshot={{
          ...baseSnapshot,
          device: {
            ...baseSnapshot.device,
            devicePresent: "needs_update",
          },
        }}
      />,
    );

    expect(screen.getByText(/incompatible firmware/i)).toBeInTheDocument();
  });
});
