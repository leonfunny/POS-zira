// Packet E1a: the staff-JWT, salon-scoped print-agent REST routes are PERMITTED
// (the Android staff app calls them with the staff JWT exactly as the Windows
// staff POS does — receipt COPY print). The pa_-keyed execution surface
// (agent/connect/my-key + the x-print-agent-* identity headers) stays forbidden;
// see the sibling forbidden-print-agent-* fixtures.
export const createJobRoute = '/api/v1/print-agent/jobs';
export const jobStatusRoute = '/api/v1/print-agent/jobs/abc-123';
export const assignmentRoute = '/api/v1/print-agent/salons/me/printer-assignments';
