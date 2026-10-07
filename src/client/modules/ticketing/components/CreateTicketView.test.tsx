import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RequestTypeDefinition, TicketDetail } from "../../../../server/types";

const createTicket = vi.fn(() => Promise.resolve({ ticket: { id: "T-1", stage: "Submitted" } as unknown as TicketDetail }));
vi.mock("../api", () => ({ createTicket }));

const { CreateTicketView } = await import("./CreateTicketView");

const requestTypes = [
  { id: "ci-cd-pipeline", name: "CI/CD Pipeline", description: "", ownerTeam: "x", fields: [] },
] as unknown as RequestTypeDefinition[];

describe("CreateTicketView", () => {
  it("sends on Ctrl+Enter, with no description", async () => {
    const onCreated = vi.fn(() => Promise.resolve());
    render(<CreateTicketView requestTypes={requestTypes} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText("Ticket name"), { target: { value: "Open port 8443" } });
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("Ticket name"), { key: "Enter", ctrlKey: true });
    });
    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ fields: { title: "Open port 8443", description: "" } })
    );
    expect(onCreated).toHaveBeenCalled();
  });

  it("leaves Enter alone in the description, and needs a name", async () => {
    createTicket.mockClear();
    render(<CreateTicketView requestTypes={requestTypes} onCreated={() => Promise.resolve()} />);
    const description = screen.getByLabelText(/Description/);
    await act(async () => {
      fireEvent.keyDown(description, { key: "Enter" });
      fireEvent.keyDown(description, { key: "Enter", ctrlKey: true });
    });
    // No name yet: the same validation a click on Submit runs holds it back.
    expect(createTicket).not.toHaveBeenCalled();
  });
});
