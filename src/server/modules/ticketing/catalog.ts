import { z } from "zod";
import type { RequestTypeDefinition } from "../../types";

// One entry, because the create form collects one shape: name, description,
// priority. Two other types (OpenShift Access, Incident Support) and their
// per-type fields lived here for a UI that was never built — the form always
// took requestTypes[0] and filled every other field with the title. Add an
// entry here plus a picker in CreateTicketView if the portal ever needs more.
export const requestCatalog: RequestTypeDefinition[] = [
  {
    id: "ci-cd-pipeline",
    name: "CI/CD Pipeline",
    description: "Create or update build, test, deploy, or release automation.",
    ownerTeam: "devops-platform",
    fields: [
      { name: "title", label: "Summary", required: true },
      { name: "description", label: "Request details", required: true }
    ]
  }
];

export function getRequestType(id: string): RequestTypeDefinition | undefined {
  return requestCatalog.find((requestType) => requestType.id === id);
}

export function validateRequestFields(requestTypeId: string, fields: Record<string, unknown>): Record<string, string> {
  const requestType = getRequestType(requestTypeId);
  if (!requestType) {
    throw new Error(`Unknown request type: ${requestTypeId}`);
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of requestType.fields) {
    const schema = z.string().trim();
    shape[field.name] = field.required
      ? schema.min(1, `${field.label} is required`)
      : schema.optional().default("");
  }

  return z.object(shape).parse(fields) as Record<string, string>;
}
