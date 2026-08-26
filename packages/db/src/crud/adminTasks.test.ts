/**
 * AdminTask domain crud (Trustance Master Architecture Task 9a): createAdminTask,
 * listAdminTasks/countAdminTasks filtering, and the assign/start/complete/
 * escalate state machine (ADMIN_TASK_LEGAL_TRANSITIONS).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { AdminTaskPriority, AdminTaskStatus, AdminTaskType } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect } from "./orders";
import { createRefund } from "./refunds";
import {
  createAdminTask,
  listAdminTasks,
  countAdminTasks,
  assignAdminTask,
  startAdminTask,
  completeAdminTask,
  escalateAdminTask,
  ADMIN_TASK_LEGAL_TRANSITIONS,
} from "./adminTasks";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

async function makeOrderWithItem(quantity = 1) {
  const order = await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity });
  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order!.id } });
  return { order: order!, item };
}

async function makeAdmin() {
  return prisma.user.create({
    data: {
      telegramId: Math.floor(Math.random() * 1_000_000_000),
      username: "admin",
      fullName: "Admin",
      role: "ADMIN",
      referralCode: `a${Math.random()}`,
    },
  });
}

async function makeCustomer() {
  return prisma.user.create({
    data: {
      telegramId: Math.floor(Math.random() * 1_000_000_000),
      username: "cust",
      fullName: "Customer",
      role: "CUSTOMER",
      referralCode: `c${Math.random()}`,
    },
  });
}

describe("createAdminTask", () => {
  it("creates a PENDING, unassigned task", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();

    const task = await createAdminTask(prisma, {
      type: AdminTaskType.MANUAL_DELIVERY,
      orderId: order.id,
      adminId: admin.id,
    });

    expect(task.status).toBe(AdminTaskStatus.PENDING);
    expect(task.assignedTo).toBeNull();
    expect(task.priority).toBe(AdminTaskPriority.MEDIUM);
    expect(task.completedAt).toBeNull();
  });

  it("accepts an explicit priority", async () => {
    const admin = await makeAdmin();
    const task = await createAdminTask(prisma, {
      type: AdminTaskType.REQUEST_CUSTOMER_INFO,
      priority: AdminTaskPriority.URGENT,
      adminId: admin.id,
    });
    expect(task.priority).toBe(AdminTaskPriority.URGENT);
  });

  it("allows a task with no order/orderItem/refund reference at all", async () => {
    const admin = await makeAdmin();
    const task = await createAdminTask(prisma, {
      type: AdminTaskType.MANUAL_ACCOUNT_ASSIGNMENT,
      adminId: admin.id,
    });
    expect(task.orderId).toBeNull();
    expect(task.orderItemId).toBeNull();
    expect(task.refundId).toBeNull();
  });

  it("accepts orderItemId that belongs to the given orderId", async () => {
    const { order, item } = await makeOrderWithItem();
    const admin = await makeAdmin();

    const task = await createAdminTask(prisma, {
      type: AdminTaskType.FAILED_TOPUP_REVIEW,
      orderId: order.id,
      orderItemId: item.id,
      adminId: admin.id,
    });
    expect(task.orderItemId).toBe(item.id);
  });

  it("accepts refundId that belongs to the given orderId", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });

    const task = await createAdminTask(prisma, {
      type: AdminTaskType.REFUND_REVIEW,
      orderId: order.id,
      refundId: refund.id,
      adminId: admin.id,
    });
    expect(task.refundId).toBe(refund.id);
  });

  it("audits the creation with the acting admin id", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();

    const task = await createAdminTask(prisma, {
      type: AdminTaskType.MANUAL_DELIVERY,
      orderId: order.id,
      adminId: admin.id,
    });

    const auditRows = await prisma.auditLog.findMany({ where: { action: "admin_task_created", targetId: task.id } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.adminId).toBe(admin.id);
    expect(auditRows[0]!.details).toContain(order.orderCode);
    expect(auditRows[0]!.details).toContain(AdminTaskType.MANUAL_DELIVERY);
  });

  it("rejects an unknown type", async () => {
    const admin = await makeAdmin();
    await expect(
      createAdminTask(prisma, { type: "NOT_A_REAL_TYPE", adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects an unknown priority", async () => {
    const admin = await makeAdmin();
    await expect(
      createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, priority: "SUPER_URGENT", adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a non-existent orderId", async () => {
    const admin = await makeAdmin();
    await expect(
      createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, orderId: 999_999_999, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a non-existent orderItemId", async () => {
    const admin = await makeAdmin();
    await expect(
      createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, orderItemId: 999_999_999, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a non-existent refundId", async () => {
    const admin = await makeAdmin();
    await expect(
      createAdminTask(prisma, { type: AdminTaskType.REFUND_REVIEW, refundId: 999_999_999, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects an orderItemId that belongs to a different order than the given orderId", async () => {
    const { order: orderA } = await makeOrderWithItem();
    const { item: itemB } = await makeOrderWithItem();
    const admin = await makeAdmin();

    await expect(
      createAdminTask(prisma, {
        type: AdminTaskType.FAILED_TOPUP_REVIEW,
        orderId: orderA.id,
        orderItemId: itemB.id,
        adminId: admin.id,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a refundId that belongs to a different order than the given orderId", async () => {
    const { order: orderA } = await makeOrderWithItem();
    const { order: orderB } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const refundB = await createRefund(prisma, { orderId: orderB.id, amount: "1.00", currency: "IDR", adminId: admin.id });

    await expect(
      createAdminTask(prisma, {
        type: AdminTaskType.REFUND_REVIEW,
        orderId: orderA.id,
        refundId: refundB.id,
        adminId: admin.id,
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("listAdminTasks / countAdminTasks", () => {
  it("filters by status/type/assignedTo/orderId/priority", async () => {
    const { order: orderA } = await makeOrderWithItem();
    const { order: orderB } = await makeOrderWithItem();
    const admin = await makeAdmin();

    const task1 = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, orderId: orderA.id, priority: AdminTaskPriority.HIGH, adminId: admin.id });
    const task2 = await createAdminTask(prisma, { type: AdminTaskType.REQUEST_CUSTOMER_INFO, orderId: orderA.id, adminId: admin.id });
    await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, orderId: orderB.id, adminId: admin.id });

    await assignAdminTask(prisma, { taskId: task1.id, from: AdminTaskStatus.PENDING, assignedTo: admin.id, adminId: admin.id });

    const forOrderA = await listAdminTasks(prisma, { orderId: orderA.id });
    expect(forOrderA.map((t) => t.id).sort()).toEqual([task1.id, task2.id].sort());

    const highPriority = await listAdminTasks(prisma, { priority: AdminTaskPriority.HIGH });
    expect(highPriority.map((t) => t.id)).toEqual([task1.id]);

    const assignedToAdmin = await listAdminTasks(prisma, { assignedTo: admin.id });
    expect(assignedToAdmin.map((t) => t.id)).toEqual([task1.id]);

    const manualDelivery = await listAdminTasks(prisma, { type: AdminTaskType.MANUAL_DELIVERY });
    expect(manualDelivery.length).toBeGreaterThanOrEqual(2);

    const pendingCount = await countAdminTasks(prisma, { status: AdminTaskStatus.PENDING });
    expect(pendingCount).toBeGreaterThanOrEqual(2);
  });

  it("includes order/orderItem/refund/assignee relations", async () => {
    const { order, item } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "1.00", currency: "IDR", adminId: admin.id });
    const task = await createAdminTask(prisma, {
      type: AdminTaskType.REFUND_REVIEW,
      orderId: order.id,
      orderItemId: item.id,
      refundId: refund.id,
      adminId: admin.id,
    });
    await assignAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.PENDING, assignedTo: admin.id, adminId: admin.id });

    const [found] = await listAdminTasks(prisma, { orderId: order.id });
    expect(found!.order?.orderCode).toBe(order.orderCode);
    expect(found!.orderItem?.id).toBe(item.id);
    expect(found!.refund?.id).toBe(refund.id);
    expect(found!.assignee?.id).toBe(admin.id);
  });
});

describe("state machine — ADMIN_TASK_LEGAL_TRANSITIONS", () => {
  it("encodes exactly the documented shape", () => {
    expect(ADMIN_TASK_LEGAL_TRANSITIONS[AdminTaskStatus.PENDING]!.slice().sort()).toEqual(
      [AdminTaskStatus.ASSIGNED, AdminTaskStatus.ESCALATED].sort(),
    );
    expect(ADMIN_TASK_LEGAL_TRANSITIONS[AdminTaskStatus.ASSIGNED]!.slice().sort()).toEqual(
      [AdminTaskStatus.IN_PROGRESS, AdminTaskStatus.ESCALATED].sort(),
    );
    expect(ADMIN_TASK_LEGAL_TRANSITIONS[AdminTaskStatus.IN_PROGRESS]!.slice().sort()).toEqual(
      [AdminTaskStatus.COMPLETED, AdminTaskStatus.ESCALATED].sort(),
    );
    expect(ADMIN_TASK_LEGAL_TRANSITIONS[AdminTaskStatus.ESCALATED]!.slice().sort()).toEqual(
      [AdminTaskStatus.ASSIGNED, AdminTaskStatus.IN_PROGRESS, AdminTaskStatus.COMPLETED].sort(),
    );
    expect(ADMIN_TASK_LEGAL_TRANSITIONS[AdminTaskStatus.COMPLETED]).toEqual([]);
  });
});

describe("assignAdminTask", () => {
  it("PENDING -> ASSIGNED succeeds, sets assignedTo, and is audited", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const task = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, orderId: order.id, adminId: admin.id });

    const result = await assignAdminTask(prisma, {
      taskId: task.id,
      from: AdminTaskStatus.PENDING,
      assignedTo: admin.id,
      adminId: admin.id,
    });

    expect(result.status).toBe(AdminTaskStatus.ASSIGNED);
    expect(result.assignedTo).toBe(admin.id);

    const auditRows = await prisma.auditLog.findMany({ where: { action: "admin_task_status_change", targetId: task.id } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.details).toContain("PENDING");
    expect(auditRows[0]!.details).toContain("ASSIGNED");
  });

  it("ESCALATED -> ASSIGNED succeeds (reassign after escalation)", async () => {
    const admin = await makeAdmin();
    const secondAdmin = await makeAdmin();
    const task = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, adminId: admin.id });
    await escalateAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.PENDING, adminId: admin.id });

    const result = await assignAdminTask(prisma, {
      taskId: task.id,
      from: AdminTaskStatus.ESCALATED,
      assignedTo: secondAdmin.id,
      adminId: admin.id,
    });
    expect(result.status).toBe(AdminTaskStatus.ASSIGNED);
    expect(result.assignedTo).toBe(secondAdmin.id);
  });

  it("rejects assigning to a non-existent user", async () => {
    const admin = await makeAdmin();
    const task = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, adminId: admin.id });
    await expect(
      assignAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.PENDING, assignedTo: 999_999_999, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects assigning to a non-admin user", async () => {
    const admin = await makeAdmin();
    const customer = await makeCustomer();
    const task = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, adminId: admin.id });
    await expect(
      assignAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.PENDING, assignedTo: customer.id, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects assigning from an illegal from-state (e.g. IN_PROGRESS)", async () => {
    const admin = await makeAdmin();
    const task = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, adminId: admin.id });
    await assignAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.PENDING, assignedTo: admin.id, adminId: admin.id });
    await startAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.ASSIGNED, adminId: admin.id });

    await expect(
      assignAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.IN_PROGRESS, assignedTo: admin.id, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("startAdminTask", () => {
  it("ASSIGNED -> IN_PROGRESS succeeds", async () => {
    const admin = await makeAdmin();
    const task = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, adminId: admin.id });
    await assignAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.PENDING, assignedTo: admin.id, adminId: admin.id });

    const result = await startAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.ASSIGNED, adminId: admin.id });
    expect(result.status).toBe(AdminTaskStatus.IN_PROGRESS);
  });

  it("ESCALATED -> IN_PROGRESS succeeds (resume directly)", async () => {
    const admin = await makeAdmin();
    const task = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, adminId: admin.id });
    await assignAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.PENDING, assignedTo: admin.id, adminId: admin.id });
    await escalateAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.ASSIGNED, adminId: admin.id });

    const result = await startAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.ESCALATED, adminId: admin.id });
    expect(result.status).toBe(AdminTaskStatus.IN_PROGRESS);
  });

  it("rejects PENDING -> IN_PROGRESS (must be assigned first)", async () => {
    const admin = await makeAdmin();
    const task = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, adminId: admin.id });
    await expect(
      startAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.PENDING, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("completeAdminTask", () => {
  it("IN_PROGRESS -> COMPLETED succeeds and stamps completedAt", async () => {
    const admin = await makeAdmin();
    const task = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, adminId: admin.id });
    await assignAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.PENDING, assignedTo: admin.id, adminId: admin.id });
    await startAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.ASSIGNED, adminId: admin.id });

    const result = await completeAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.IN_PROGRESS, adminId: admin.id });
    expect(result.status).toBe(AdminTaskStatus.COMPLETED);
    expect(result.completedAt).toBeInstanceOf(Date);
  });

  it("ESCALATED -> COMPLETED succeeds (resolved as escalated, without resuming first)", async () => {
    const admin = await makeAdmin();
    const task = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, adminId: admin.id });
    await escalateAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.PENDING, adminId: admin.id });

    const result = await completeAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.ESCALATED, adminId: admin.id });
    expect(result.status).toBe(AdminTaskStatus.COMPLETED);
    expect(result.completedAt).toBeInstanceOf(Date);
  });

  it("rejects completing from PENDING or ASSIGNED", async () => {
    const admin = await makeAdmin();
    const taskPending = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, adminId: admin.id });
    await expect(
      completeAdminTask(prisma, { taskId: taskPending.id, from: AdminTaskStatus.PENDING, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);

    const taskAssigned = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, adminId: admin.id });
    await assignAdminTask(prisma, { taskId: taskAssigned.id, from: AdminTaskStatus.PENDING, assignedTo: admin.id, adminId: admin.id });
    await expect(
      completeAdminTask(prisma, { taskId: taskAssigned.id, from: AdminTaskStatus.ASSIGNED, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects completing an already-COMPLETED task (terminal)", async () => {
    const admin = await makeAdmin();
    const task = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, adminId: admin.id });
    await assignAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.PENDING, assignedTo: admin.id, adminId: admin.id });
    await startAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.ASSIGNED, adminId: admin.id });
    await completeAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.IN_PROGRESS, adminId: admin.id });

    await expect(
      completeAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.IN_PROGRESS, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("escalateAdminTask", () => {
  it("escalates from PENDING, ASSIGNED, and IN_PROGRESS", async () => {
    const admin = await makeAdmin();

    const t1 = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, adminId: admin.id });
    const r1 = await escalateAdminTask(prisma, { taskId: t1.id, from: AdminTaskStatus.PENDING, adminId: admin.id });
    expect(r1.status).toBe(AdminTaskStatus.ESCALATED);

    const t2 = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, adminId: admin.id });
    await assignAdminTask(prisma, { taskId: t2.id, from: AdminTaskStatus.PENDING, assignedTo: admin.id, adminId: admin.id });
    const r2 = await escalateAdminTask(prisma, { taskId: t2.id, from: AdminTaskStatus.ASSIGNED, adminId: admin.id });
    expect(r2.status).toBe(AdminTaskStatus.ESCALATED);
    expect(r2.assignedTo).toBe(admin.id); // escalate does not clear the assignee

    const t3 = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, adminId: admin.id });
    await assignAdminTask(prisma, { taskId: t3.id, from: AdminTaskStatus.PENDING, assignedTo: admin.id, adminId: admin.id });
    await startAdminTask(prisma, { taskId: t3.id, from: AdminTaskStatus.ASSIGNED, adminId: admin.id });
    const r3 = await escalateAdminTask(prisma, { taskId: t3.id, from: AdminTaskStatus.IN_PROGRESS, adminId: admin.id });
    expect(r3.status).toBe(AdminTaskStatus.ESCALATED);
  });

  it("rejects escalating an already-COMPLETED task (terminal)", async () => {
    const admin = await makeAdmin();
    const task = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, adminId: admin.id });
    await assignAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.PENDING, assignedTo: admin.id, adminId: admin.id });
    await startAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.ASSIGNED, adminId: admin.id });
    await completeAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.IN_PROGRESS, adminId: admin.id });

    await expect(
      escalateAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.COMPLETED, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("stale-claim / non-existent-row handling", () => {
  it("rejects a transition whose `from` no longer matches the row's actual status (stale claim)", async () => {
    const admin = await makeAdmin();
    const task = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, adminId: admin.id });
    await assignAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.PENDING, assignedTo: admin.id, adminId: admin.id });

    // Row is now ASSIGNED; claiming PENDING -> ASSIGNED again must fail.
    await expect(
      assignAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.PENDING, assignedTo: admin.id, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects transitioning a non-existent task", async () => {
    const admin = await makeAdmin();
    await expect(
      startAdminTask(prisma, { taskId: 999_999_999, from: AdminTaskStatus.ASSIGNED, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("does not write an audit row for a rejected transition", async () => {
    const admin = await makeAdmin();
    const task = await createAdminTask(prisma, { type: AdminTaskType.MANUAL_DELIVERY, adminId: admin.id });

    await expect(
      startAdminTask(prisma, { taskId: task.id, from: AdminTaskStatus.PENDING, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);

    const auditRows = await prisma.auditLog.findMany({ where: { action: "admin_task_status_change", targetId: task.id } });
    expect(auditRows).toHaveLength(0);
  });
});
