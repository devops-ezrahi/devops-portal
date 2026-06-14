import { mapInternalStatus } from "../status";
import type { TicketDetail } from "../../../types";

export function seedTickets(): TicketDetail[] {
  return [
    {
      id: "DEVOPS-1001",
      title: "Add deploy gate to payments pipeline",
      requestType: "CI/CD Pipeline",
      requesterId: "u-alex",
      requesterName: "Alex Morgan",
      teamGroups: ["team-alpha", "devops-platform"],
      rawStatus: "In Progress",
      stage: mapInternalStatus("In Progress"),
      assigneeId: "",
      createdAt: "2026-06-05T08:30:00.000Z",
      updatedAt: "2026-06-07T10:15:00.000Z",
      lastActivityAt: "2026-06-07T10:15:00.000Z",
      description: "Production deployments need a manual approval gate before promotion.",
      metadata: {
        application: "payments-api",
        repository: "https://git.example.com/payments/api",
        environment: "Production"
      },
      comments: [
        {
          id: "c-1001-1",
          authorName: "DevOps Support",
          authorId: "svc-devops",
          body: "Pipeline ownership confirmed. Implementing the approval gate now.",
          createdAt: "2026-06-07T10:15:00.000Z"
        }
      ]
    },
    {
      id: "DEVOPS-1002",
      title: "Namespace quota increase for inventory",
      requestType: "OpenShift Access",
      requesterId: "u-riley",
      requesterName: "Riley Chen",
      teamGroups: ["team-alpha", "platform-operations"],
      rawStatus: "Waiting on Customer",
      stage: mapInternalStatus("Waiting on Customer"),
      assigneeId: "",
      createdAt: "2026-06-04T12:00:00.000Z",
      updatedAt: "2026-06-06T14:20:00.000Z",
      lastActivityAt: "2026-06-06T14:20:00.000Z",
      description: "Inventory service needs more CPU and memory quota for load tests.",
      metadata: {
        cluster: "ocp4-prod",
        namespace: "inventory-prod",
        accessLevel: "Admin"
      },
      comments: [
        {
          id: "c-1002-1",
          authorName: "Platform Operations",
          authorId: "svc-platform",
          body: "Please confirm the requested quota values and approval reference.",
          createdAt: "2026-06-06T14:20:00.000Z"
        }
      ]
    },
    {
      id: "DEVOPS-1003",
      title: "Investigate failed nightly deployment",
      requestType: "Incident Support",
      requesterId: "u-jordan",
      requesterName: "Jordan Patel",
      teamGroups: ["team-beta", "devops-support"],
      rawStatus: "Resolved",
      stage: mapInternalStatus("Resolved"),
      assigneeId: "",
      createdAt: "2026-06-01T09:45:00.000Z",
      updatedAt: "2026-06-03T16:05:00.000Z",
      lastActivityAt: "2026-06-03T16:05:00.000Z",
      description: "Nightly deployment failed during image promotion.",
      metadata: {
        severity: "Medium",
        system: "reporting-worker"
      },
      comments: []
    }
  ];
}
