import { z } from "zod";
import type { RequestTypeDefinition } from "../../types";

export const requestCatalog: RequestTypeDefinition[] = [
  {
    id: "ci-cd-pipeline",
    name: "CI/CD Pipeline",
    description: "Create or update build, test, deploy, or release automation.",
    ownerTeam: "devops-platform",
    fields: [
      { name: "title", label: "Summary", type: "text", required: true },
      { name: "application", label: "Application", type: "text", required: true },
      { name: "repository", label: "Repository URL", type: "text", required: true },
      {
        name: "environment",
        label: "Target environment",
        type: "select",
        required: true,
        options: ["Development", "Test", "Staging", "Production"]
      },
      { name: "description", label: "Request details", type: "textarea", required: true }
    ]
  },
  {
    id: "openshift-access",
    name: "OpenShift Access",
    description: "Request project, role, quota, route, or secret access changes.",
    ownerTeam: "platform-operations",
    fields: [
      { name: "title", label: "Summary", type: "text", required: true },
      { name: "cluster", label: "Cluster", type: "text", required: true },
      { name: "namespace", label: "Namespace", type: "text", required: true },
      {
        name: "accessLevel",
        label: "Access level",
        type: "select",
        required: true,
        options: ["View", "Edit", "Admin", "Route", "Secret"]
      },
      { name: "description", label: "Business justification", type: "textarea", required: true }
    ]
  },
  {
    id: "incident-support",
    name: "Incident Support",
    description: "Ask DevOps to investigate deployment, platform, or automation issues.",
    ownerTeam: "devops-support",
    fields: [
      { name: "title", label: "Incident summary", type: "text", required: true },
      {
        name: "severity",
        label: "Severity",
        type: "select",
        required: true,
        options: ["Low", "Medium", "High", "Critical"]
      },
      { name: "system", label: "Affected system", type: "text", required: true },
      { name: "description", label: "Symptoms and impact", type: "textarea", required: true }
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
    let schema = z.string().trim();
    if (field.required) {
      schema = schema.min(1, `${field.label} is required`);
    }
    if (field.options?.length) {
      schema = schema.refine((value) => field.options?.includes(value), {
        message: `${field.label} must be one of: ${field.options.join(", ")}`
      });
    }
    shape[field.name] = field.required ? schema : schema.optional().default("");
  }

  return z.object(shape).parse(fields) as Record<string, string>;
}
