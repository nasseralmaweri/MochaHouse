import { Injectable } from '@nestjs/common';
import { Prisma } from '@mocha-house/database';
import type { InternalUserStatus } from '@mocha-house/contracts';

// The write side of the access-control audit foundation (Milestone 5E-3).
// Small and structured on purpose: callers pass typed input, never SQL, and
// every write MUST run inside the same transaction as the change it records
// — the `tx` parameter is mandatory. Audit is durable application history,
// written synchronously; it is deliberately NOT an OutboxEvent.
@Injectable()
export class InternalAuditService {
  // Records a completed internal-user status change. Call this with the
  // SAME `tx` that performed the InternalUser.update, so the update and the
  // audit row commit or roll back together.
  async recordUserStatusChanged(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      targetInternalUserId: string;
      before: InternalUserStatus;
      after: InternalUserStatus;
      reason: string;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'user.status_changed',
        targetType: 'internal_user',
        targetId: input.targetInternalUserId,
        beforeData: { status: input.before },
        afterData: { status: input.after },
        reason: input.reason,
      },
    });
  }

  // Records a completed access-level assignment (Milestone 5E-4). Call with
  // the SAME `tx` that created the InternalUserRoleAssignment row. The event
  // snapshots the access level's display name and the location's name so
  // the record stays legible even if the role or location is later renamed
  // or removed. `beforeData` is the absence of the grant; `afterData` is
  // the grant.
  async recordRoleAssigned(
    tx: Prisma.TransactionClient,
    input: RoleAssignmentAuditInput,
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'user.role_assigned',
        targetType: 'internal_user',
        targetId: input.targetInternalUserId,
        beforeData: { assignment: null },
        afterData: { assignment: assignmentSnapshot(input) },
        reason: input.reason,
      },
    });
  }

  // Records a completed access-level removal (Milestone 5E-4) — the mirror
  // image of recordRoleAssigned. Call with the SAME `tx` that deleted the
  // InternalUserRoleAssignment row.
  async recordRoleRemoved(
    tx: Prisma.TransactionClient,
    input: RoleAssignmentAuditInput,
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'user.role_removed',
        targetType: 'internal_user',
        targetId: input.targetInternalUserId,
        beforeData: { assignment: assignmentSnapshot(input) },
        afterData: { assignment: null },
        reason: input.reason,
      },
    });
  }

  // Records a logged / cleared Opening Checklist management exception
  // (Milestone 6C). Waiving a standard opening requirement is a significant
  // management decision, so it is durable history — unlike routine task and
  // checklist Complete/Undo, which are NOT audited. Call with the SAME `tx`
  // that set / cleared the exception fields on the ChecklistInstanceItem.
  // `targetType` is 'checklist_instance_item' (a new polymorphic target —
  // the audit table has always been polymorphic by design); the Admin
  // Activity Log, which is scoped to administrative-access changes, ignores
  // non-`internal_user` targets.
  async recordChecklistExceptionLogged(
    tx: Prisma.TransactionClient,
    input: ChecklistExceptionAuditInput & { reason: string },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'operations.checklist_exception_logged',
        targetType: 'checklist_instance_item',
        targetId: input.checklistInstanceItemId,
        beforeData: { resolution: 'open' },
        afterData: {
          resolution: 'exception',
          reason: input.reason,
          ...checklistExceptionContext(input),
        },
        reason: input.reason,
      },
    });
  }

  // Records a completed manual HQ Mocha Bean adjustment (Milestone 7A).
  // Manually moving a customer's Bean balance is a sensitive HQ action, so
  // it is administrative history in addition to the authoritative
  // MochaBeanLedgerEntry the same transaction writes. Call with the SAME
  // `tx` that inserted the ledger entry and updated the balance.
  //
  // `targetType` is 'customer' (a new polymorphic target — the audit table
  // has always been polymorphic by design). The Admin Activity Log is
  // scoped to `internal_user` targets and ignores this, exactly as it
  // ignores the 6C `checklist_instance_item` events.
  async recordMochaBeansAdjusted(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      customerId: string;
      deltaBeans: number;
      balanceBefore: number;
      balanceAfter: number;
      reason: string;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'loyalty.beans_adjusted',
        targetType: 'customer',
        targetId: input.customerId,
        beforeData: { balance: input.balanceBefore },
        afterData: {
          balance: input.balanceAfter,
          delta: input.deltaBeans,
        },
        reason: input.reason,
      },
    });
  }

  // --- Milestone 7B, HQ loyalty configuration + Rewards Catalog -----
  // Sensitive HQ configuration changes. Like every method here, each writes
  // in the SAME transaction as the change it records. The reward /
  // configuration tables remain the source of truth — these events are the
  // "who changed what, when" administrative trail, not reward data.
  //
  // targetType is 'loyalty_configuration' / 'loyalty_reward' — new
  // polymorphic targets. The Admin Activity Log is scoped to
  // 'internal_user' targets and ignores these, exactly as it ignores the 6C
  // 'checklist_instance_item' and 7A 'customer' events.

  async recordLoyaltyEarningRateChanged(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      beforeRatePerDollar: number;
      afterRatePerDollar: number;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'loyalty.earning_rate_changed',
        targetType: 'loyalty_configuration',
        targetId: 'company',
        beforeData: { earningRatePerDollar: input.beforeRatePerDollar },
        afterData: { earningRatePerDollar: input.afterRatePerDollar },
        reason: `Standard earning rate changed from ${input.beforeRatePerDollar} to ${input.afterRatePerDollar} Mocha Beans per qualifying dollar.`,
      },
    });
  }

  async recordLoyaltyRewardCreated(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      rewardId: string;
      snapshot: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'loyalty.reward_created',
        targetType: 'loyalty_reward',
        targetId: input.rewardId,
        // No beforeData — the reward did not exist.
        afterData: input.snapshot,
        reason: 'Loyalty reward created.',
      },
    });
  }

  async recordLoyaltyRewardUpdated(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      rewardId: string;
      change: 'updated' | 'activated' | 'deactivated';
      before: Prisma.InputJsonValue;
      after: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    const action =
      input.change === 'activated'
        ? 'loyalty.reward_activated'
        : input.change === 'deactivated'
          ? 'loyalty.reward_deactivated'
          : 'loyalty.reward_updated';
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action,
        targetType: 'loyalty_reward',
        targetId: input.rewardId,
        beforeData: input.before,
        afterData: input.after,
        reason:
          input.change === 'activated'
            ? 'Loyalty reward activated.'
            : input.change === 'deactivated'
              ? 'Loyalty reward deactivated.'
              : 'Loyalty reward updated.',
      },
    });
  }

  // --- Milestone 7D, Bonus Mocha Beans Promotions -----------------
  // Same contract as every method here: written in the SAME transaction as
  // the promotion change it records. The LoyaltyBonusPromotion tables stay
  // the source of truth — these events are the "who changed what, when"
  // trail. targetType 'loyalty_bonus_promotion' is a new polymorphic
  // target; the Admin Activity Log is scoped to 'internal_user' and ignores
  // it, exactly as it ignores the 7B 'loyalty_reward' events. Routine
  // customer bonus earning is NOT audited — the immutable OrderLoyaltyBonus
  // snapshot and the Bean ledger are its operational history.

  async recordLoyaltyBonusPromotionCreated(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      promotionId: string;
      snapshot: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'loyalty.bonus_promotion_created',
        targetType: 'loyalty_bonus_promotion',
        targetId: input.promotionId,
        afterData: input.snapshot,
        reason: 'Bonus Mocha Bean promotion created.',
      },
    });
  }

  async recordLoyaltyBonusPromotionUpdated(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      promotionId: string;
      change: 'updated' | 'activated' | 'deactivated';
      before: Prisma.InputJsonValue;
      after: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    const action =
      input.change === 'activated'
        ? 'loyalty.bonus_promotion_activated'
        : input.change === 'deactivated'
          ? 'loyalty.bonus_promotion_deactivated'
          : 'loyalty.bonus_promotion_updated';
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action,
        targetType: 'loyalty_bonus_promotion',
        targetId: input.promotionId,
        beforeData: input.before,
        afterData: input.after,
        reason:
          input.change === 'activated'
            ? 'Bonus Mocha Bean promotion activated.'
            : input.change === 'deactivated'
              ? 'Bonus Mocha Bean promotion deactivated.'
              : 'Bonus Mocha Bean promotion updated.',
      },
    });
  }

  // --- Milestone 7E, Promotions & Coupons ------------------------
  // Same contract as every method here — written in the SAME transaction as
  // the promotion change it records. The Promotion tables stay the source
  // of truth; these events are the "who changed what, when" trail.
  // targetType 'promotion' is a new polymorphic target; the Admin Activity
  // Log is scoped to 'internal_user' and ignores it, exactly as it ignores
  // the 7B/7D loyalty events. Routine customer redemption is NOT audited —
  // the immutable OrderPromotionRedemption snapshot is its history.

  async recordPromotionCreated(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      promotionId: string;
      snapshot: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'promotions.promotion_created',
        targetType: 'promotion',
        targetId: input.promotionId,
        afterData: input.snapshot,
        reason: 'Promotion / Coupon created.',
      },
    });
  }

  async recordPromotionUpdated(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      promotionId: string;
      change: 'updated' | 'activated' | 'deactivated';
      before: Prisma.InputJsonValue;
      after: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    const action =
      input.change === 'activated'
        ? 'promotions.promotion_activated'
        : input.change === 'deactivated'
          ? 'promotions.promotion_deactivated'
          : 'promotions.promotion_updated';
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action,
        targetType: 'promotion',
        targetId: input.promotionId,
        beforeData: input.before,
        afterData: input.after,
        reason:
          input.change === 'activated'
            ? 'Promotion / Coupon activated.'
            : input.change === 'deactivated'
              ? 'Promotion / Coupon deactivated.'
              : 'Promotion / Coupon updated.',
      },
    });
  }

  // --- Milestone 7F, Gift Card Foundation & Administration --------
  // Same contract as every method here — written in the SAME transaction as
  // the gift-card change it records. The GiftCard / GiftCardTransaction
  // tables stay the authoritative financial record; these events are the
  // "who changed what, when, and why" administrative trail. A manual
  // balance correction writes BOTH the GiftCardTransaction ledger row and
  // this audit event in one transaction (mirrors loyalty.beans_adjusted).
  // targetType 'gift_card' / 'giftcard_configuration' are new polymorphic
  // targets; the Admin Activity Log is scoped to 'internal_user' and
  // ignores them, exactly as it ignores the 7A–7E events. The full
  // gift-card code is NEVER placed in beforeData / afterData / reason —
  // only the last 4 characters.

  async recordGiftCardIssued(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      giftCardId: string;
      last4: string;
      originalValueMinorUnits: number;
      currency: string;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'giftcards.card_issued',
        targetType: 'gift_card',
        targetId: input.giftCardId,
        // No beforeData — the card did not exist.
        afterData: {
          last4: input.last4,
          originalValueMinorUnits: input.originalValueMinorUnits,
          currency: input.currency,
        },
        reason: 'Gift card issued by HQ.',
      },
    });
  }

  async recordGiftCardStatusChanged(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      giftCardId: string;
      before: 'ACTIVE' | 'INACTIVE';
      after: 'ACTIVE' | 'INACTIVE';
      reason: string;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action:
          input.after === 'INACTIVE'
            ? 'giftcards.card_deactivated'
            : 'giftcards.card_reactivated',
        targetType: 'gift_card',
        targetId: input.giftCardId,
        beforeData: { status: input.before },
        afterData: { status: input.after },
        reason: input.reason,
      },
    });
  }

  async recordGiftCardBalanceCorrected(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      giftCardId: string;
      deltaMinorUnits: number;
      balanceBeforeMinorUnits: number;
      balanceAfterMinorUnits: number;
      reason: string;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'giftcards.balance_corrected',
        targetType: 'gift_card',
        targetId: input.giftCardId,
        beforeData: { balanceMinorUnits: input.balanceBeforeMinorUnits },
        afterData: {
          balanceMinorUnits: input.balanceAfterMinorUnits,
          deltaMinorUnits: input.deltaMinorUnits,
        },
        reason: input.reason,
      },
    });
  }

  async recordGiftCardConfigurationUpdated(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      before: {
        presetAmountsMinorUnits: number[];
        customAmountEnabled: boolean;
      };
      after: {
        presetAmountsMinorUnits: number[];
        customAmountEnabled: boolean;
      };
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'giftcards.configuration_updated',
        targetType: 'giftcard_configuration',
        targetId: 'company',
        beforeData: input.before,
        afterData: input.after,
        reason: 'Gift-card purchasing configuration updated.',
      },
    });
  }

  // --- Milestone 8A, HQ CRM foundation --------------------------
  // Adding an internal CRM note to a customer is a significant CRM
  // administrative action, so it is durable history in addition to the
  // CustomerNote row the SAME transaction writes. Call with the SAME `tx`
  // that created the note. targetType is 'customer' (the polymorphic target
  // 7A already introduced); the Admin Activity Log is scoped to
  // 'internal_user' targets and ignores this. The note body is NOT copied
  // into beforeData / afterData — only its id and length — so the audit
  // trail records "a note was added" without duplicating its content.
  async recordCustomerNoteAdded(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      customerId: string;
      noteId: string;
      noteLength: number;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'crm.note_added',
        targetType: 'customer',
        targetId: input.customerId,
        // No beforeData — the note did not exist.
        afterData: { noteId: input.noteId, noteLength: input.noteLength },
        reason: 'Internal CRM note added.',
      },
    });
  }

  // --- Milestone 8B, Careers / Job Openings ---------------------
  // Same contract as every method here — written in the SAME transaction as
  // the job-opening change it records. The JobOpening table stays the
  // source of truth; these events are the "who changed what, when" trail.
  // targetType 'job_opening' is a new polymorphic target; the Admin
  // Activity Log is scoped to 'internal_user' and ignores it, exactly as it
  // ignores the 7A–8A events.

  async recordJobOpeningCreated(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      jobOpeningId: string;
      snapshot: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'careers.job_created',
        targetType: 'job_opening',
        targetId: input.jobOpeningId,
        afterData: input.snapshot,
        reason: 'Job opening created.',
      },
    });
  }

  async recordJobOpeningUpdated(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      jobOpeningId: string;
      before: Prisma.InputJsonValue;
      after: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'careers.job_updated',
        targetType: 'job_opening',
        targetId: input.jobOpeningId,
        beforeData: input.before,
        afterData: input.after,
        reason: 'Job opening updated.',
      },
    });
  }

  async recordJobOpeningStatusChanged(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      jobOpeningId: string;
      change: 'published' | 'unpublished' | 'archived';
      before: { status: string; publishedAt: string | null };
      after: { status: string; publishedAt: string | null };
    },
  ): Promise<void> {
    const action =
      input.change === 'published'
        ? 'careers.job_published'
        : input.change === 'unpublished'
          ? 'careers.job_unpublished'
          : 'careers.job_archived';
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action,
        targetType: 'job_opening',
        targetId: input.jobOpeningId,
        beforeData: input.before,
        afterData: input.after,
        reason:
          input.change === 'published'
            ? 'Job opening published.'
            : input.change === 'unpublished'
              ? 'Job opening unpublished.'
              : 'Job opening archived.',
      },
    });
  }

  // --- Milestone 8C, Applicants --------------------------------
  // Written in the SAME transaction as the change. targetType
  // 'job_application' is a new polymorphic target; the Admin Activity Log
  // is scoped to 'internal_user' and ignores it. Applicant answers / PII
  // are NEVER placed in beforeData / afterData / reason — a status event
  // carries only the status, a note event only the note id + length. The
  // public application submission itself is not audited.

  async recordJobApplicationStatusChanged(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      jobApplicationId: string;
      before: string;
      after: string;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'applicants.application_status_changed',
        targetType: 'job_application',
        targetId: input.jobApplicationId,
        beforeData: { status: input.before },
        afterData: { status: input.after },
        reason: `Application status changed from ${input.before} to ${input.after}.`,
      },
    });
  }

  async recordJobApplicationNoteAdded(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      jobApplicationId: string;
      noteId: string;
      noteLength: number;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'applicants.note_added',
        targetType: 'job_application',
        targetId: input.jobApplicationId,
        // No beforeData — the note did not exist.
        afterData: { noteId: input.noteId, noteLength: input.noteLength },
        reason: 'Internal applicant note added.',
      },
    });
  }

  // --- Milestone 8D, Franchising inquiries -----------------------
  // Written in the SAME transaction as the change. targetType
  // 'franchise_inquiry' is a new polymorphic target; the Admin Activity Log
  // is scoped to 'internal_user' and ignores it. Prospect contact details /
  // answers are NEVER placed in beforeData / afterData / reason — a status
  // event carries only the status, a note event only the note id + length.
  // The public inquiry submission itself is not audited.

  async recordFranchiseInquiryStatusChanged(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      franchiseInquiryId: string;
      before: string;
      after: string;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'franchising.inquiry_status_changed',
        targetType: 'franchise_inquiry',
        targetId: input.franchiseInquiryId,
        beforeData: { status: input.before },
        afterData: { status: input.after },
        reason: `Franchise inquiry status changed from ${input.before} to ${input.after}.`,
      },
    });
  }

  async recordFranchiseInquiryNoteAdded(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      franchiseInquiryId: string;
      noteId: string;
      noteLength: number;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'franchising.note_added',
        targetType: 'franchise_inquiry',
        targetId: input.franchiseInquiryId,
        // No beforeData — the note did not exist.
        afterData: { noteId: input.noteId, noteLength: input.noteLength },
        reason: 'Internal franchise inquiry note added.',
      },
    });
  }

  // --- Milestone 8E, CMS foundation -------------------------------
  // Written in the SAME transaction as the change. targetType 'cms_page'
  // is a new polymorphic target; the Admin Activity Log is scoped to
  // 'internal_user' and ignores it. Content VALUES are never placed in
  // beforeData / afterData / reason — a draft-save event carries only the
  // changed field keys, a publish event only the resulting status.

  async recordCmsContentUpdated(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      cmsPageId: string;
      pageKey: string;
      changedFieldKeys: string[];
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'cms.content_updated',
        targetType: 'cms_page',
        targetId: input.cmsPageId,
        afterData: {
          pageKey: input.pageKey,
          changedFieldKeys: input.changedFieldKeys,
        },
        reason: `CMS draft content updated for '${input.pageKey}'.`,
      },
    });
  }

  async recordCmsContentPublished(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      cmsPageId: string;
      pageKey: string;
      publishedAt: Date;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'cms.content_published',
        targetType: 'cms_page',
        targetId: input.cmsPageId,
        afterData: {
          pageKey: input.pageKey,
          status: 'PUBLISHED',
          publishedAt: input.publishedAt.toISOString(),
        },
        reason: `CMS content published for '${input.pageKey}'.`,
      },
    });
  }

  // --- Milestone 8F, Media Library --------------------------------
  // Written in the SAME transaction as the change. targetType 'media_asset'
  // is a new polymorphic target; the Admin Activity Log is scoped to
  // 'internal_user' and ignores it. No file bytes, storage credentials, or
  // object payload are ever placed in the audit — only compact metadata.

  async recordMediaAssetUploaded(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      mediaAssetId: string;
      fileName: string;
      contentType: string;
      fileSizeBytes: number;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'media.asset_uploaded',
        targetType: 'media_asset',
        targetId: input.mediaAssetId,
        afterData: {
          mediaAssetId: input.mediaAssetId,
          fileName: input.fileName,
          contentType: input.contentType,
          fileSizeBytes: input.fileSizeBytes,
        },
        reason: `Media asset uploaded: '${input.fileName}'.`,
      },
    });
  }

  async recordMediaAssetDeactivated(
    tx: Prisma.TransactionClient,
    input: { actorInternalUserId: string; mediaAssetId: string },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'media.asset_deactivated',
        targetType: 'media_asset',
        targetId: input.mediaAssetId,
        afterData: { mediaAssetId: input.mediaAssetId },
        reason: 'Media asset deactivated.',
      },
    });
  }

  async recordChecklistExceptionCleared(
    tx: Prisma.TransactionClient,
    input: ChecklistExceptionAuditInput & { previousReason: string },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'operations.checklist_exception_cleared',
        targetType: 'checklist_instance_item',
        targetId: input.checklistInstanceItemId,
        beforeData: {
          resolution: 'exception',
          reason: input.previousReason,
          ...checklistExceptionContext(input),
        },
        afterData: { resolution: 'open' },
        // The audit `reason` column is required; the exception reason being
        // cleared is the relevant context.
        reason: input.previousReason,
      },
    });
  }
}

interface ChecklistExceptionAuditInput {
  actorInternalUserId: string;
  checklistInstanceItemId: string;
  checklistInstanceId: string;
  locationId: string;
  locationName: string;
  itemLabel: string;
}

function checklistExceptionContext(input: ChecklistExceptionAuditInput): {
  checklistInstanceId: string;
  location: { id: string; name: string };
  itemLabel: string;
} {
  return {
    checklistInstanceId: input.checklistInstanceId,
    location: { id: input.locationId, name: input.locationName },
    itemLabel: input.itemLabel,
  };
}

interface RoleAssignmentAuditInput {
  actorInternalUserId: string;
  targetInternalUserId: string;
  roleId: string;
  roleDisplayName: string;
  scope: 'CORPORATE' | 'LOCATION';
  locationId?: string | null;
  locationName?: string | null;
  reason: string;
}

function assignmentSnapshot(input: RoleAssignmentAuditInput): {
  roleId: string;
  roleDisplayName: string;
  scope: 'CORPORATE' | 'LOCATION';
  locationId?: string;
  locationName?: string;
} {
  const snapshot: {
    roleId: string;
    roleDisplayName: string;
    scope: 'CORPORATE' | 'LOCATION';
    locationId?: string;
    locationName?: string;
  } = {
    roleId: input.roleId,
    roleDisplayName: input.roleDisplayName,
    scope: input.scope,
  };
  if (input.scope === 'LOCATION' && input.locationId) {
    snapshot.locationId = input.locationId;
    if (input.locationName) {
      snapshot.locationName = input.locationName;
    }
  }
  return snapshot;
}
