import { all, get, insert, run, transaction } from './index.js';
import { uid, nextUserId } from '../lib/ids.js';
import { nowIso, addDays } from '../lib/dates.js';
import { seedRbac } from '../services/rbac.js';
import { seedSettings, getSetting } from '../services/settings.js';
import { seedEmailTemplates } from '../services/emailTemplates.js';
import accountsService from '../services/accounts.js';
import changeRequestsService from '../services/changeRequests.js';
import documentsService from '../services/documents.js';
import audit, { ACTIONS } from '../services/audit.js';

/**
 * Idempotent bootstrap.
 *  - reference data (roles, permissions, settings, email templates) always runs
 *  - demo data (users, accounts, change requests) runs only on an empty database
 *
 * The first change request reproduces the executed PeerIslands CR01 document.
 */

const SEED_USERS = [
  { name: 'Sahaf Ahammed', email: 'labs@hyreo.com', role_code: 'ADMIN', department: 'Delivery', designation: 'Program Director' },
  { name: 'Arun Satyan', email: 'arun.satyan@hyreo.com', role_code: 'APPROVER', department: 'Leadership', designation: 'CEO' },
  { name: 'Priya Menon', email: 'cr.manager@hyreo.com', role_code: 'CR_MANAGER', department: 'Delivery', designation: 'Engagement Manager' },
  { name: 'Rahul Nair', email: 'viewer@hyreo.com', role_code: 'VIEWER', department: 'Finance', designation: 'Financial Analyst' }
];

export function seedReferenceData() {
  seedSettings();
  seedRbac();
  seedEmailTemplates();
  seedApprovalLevels();
}

function seedApprovalLevels() {
  const existing = get('SELECT COUNT(*) AS count FROM cr_approval_levels')?.count || 0;
  if (existing > 0) return;
  insert('cr_approval_levels', {
    id: uid('LVL'),
    account_id: null,
    level: 1,
    name: 'Internal Approval',
    approver_name: 'Arun Satyan',
    approver_email: 'arun.satyan@hyreo.com',
    is_active: 1,
    created_at: nowIso()
  });
}

export function seedUsers() {
  const created = [];
  for (const user of SEED_USERS) {
    const existing = get('SELECT * FROM users WHERE lower(email) = ?', [user.email]);
    if (existing) {
      created.push(existing);
      continue;
    }
    const row = {
      id: nextUserId(),
      name: user.name,
      email: user.email,
      role_code: user.role_code,
      department: user.department,
      designation: user.designation,
      is_active: 1,
      created_at: nowIso()
    };
    insert('users', row);
    created.push(row);
  }
  return created;
}

export function isSeeded() {
  return (get('SELECT COUNT(*) AS count FROM accounts')?.count || 0) > 0;
}

export function seedDemoData() {
  if (isSeeded()) return { seeded: false };

  const users = seedUsers();
  const admin = users.find((u) => u.role_code === 'ADMIN');
  const manager = users.find((u) => u.role_code === 'CR_MANAGER') || admin;
  const actor = { id: manager.id, name: manager.name, email: manager.email, type: 'USER' };
  const adminActor = { id: admin.id, name: admin.name, email: admin.email, type: 'USER' };

  const peerIslands = accountsService.create(
    {
      account: {
        account_name: 'PeerIslands',
        account_code: 'PEERISLANDS',
        legal_entity_name: 'PeerIslands US, Inc',
        customer_type: 'Enterprise',
        industry: 'Technology',
        country: 'United States',
        address: '2093 Philadelphia Pike',
        city: 'Claymont',
        state: 'Delaware',
        postal_code: '19703',
        status: 'ACTIVE',
        account_manager: 'Arun Satyan',
        cr_manager: 'Priya Menon',
        delivery_manager: 'Sahaf Ahammed',
        internal_approver_name: 'Arun Satyan',
        internal_approver_email: 'arun.satyan@hyreo.com',
        notes: 'Reference account created from the executed CR01 document dated 03 March 2026.'
      },
      msa: {
        msa_reference_number: 'PEERISLANDS-0001',
        msa_date: '2025-10-09',
        contract_start_date: '2025-10-09',
        contract_end_date: '2028-10-08',
        currency: 'INR',
        billing_entity: 'Hyreo Services India Private Limited',
        payment_terms: '30 days from the date of invoice',
        po_required: 1,
        status: 'ACTIVE'
      },
      primary_contact: {
        name: 'Nandakumar Ramachandran',
        designation: 'Delivery Head',
        email: 'delivery.contact@peerislands.example',
        phone: '+1 302 555 0142'
      },
      approval_contact: {
        name: 'Vinod Krishnan',
        designation: 'Vice President - Talent',
        email: 'customer.approver@peerislands.example',
        phone: '+1 302 555 0177'
      }
    },
    adminActor
  );

  /* ---------------- CR01 — the change request from the source document ---- */
  const cr01 = changeRequestsService.create(
    {
      account_id: peerIslands.id,
      title: 'Interview invite email enhancements',
      cr_date: '2026-03-03',
      effective_date: '2026-03-03',
      requested_by: 'Vinod Krishnan',
      customer_contact_name: 'Nandakumar Ramachandran',
      customer_contact_email: 'delivery.contact@peerislands.example',
      priority: 'MEDIUM',
      cr_type: 'ENHANCEMENT',
      description:
        'Two enhancements to the interview invitation email issued to interview panellists: attach the candidate resume and include the candidate name in the subject line.'
    },
    actor
  );

  changeRequestsService.saveItems(
    cr01.id,
    [
      {
        feature_name: 'Candidate Resume Addition',
        requested_change: 'Attaching the candidate resume in the interview invite email shared with the panellists.',
        detailed_description:
          'The candidate resume available on the candidate profile should be attached to the interview invitation email sent to the interview panel members.',
        business_justification: 'Panellists currently open the portal separately to review the resume before the interview.',
        current_behaviour: 'The interview invite email contains the interview schedule only.',
        expected_behaviour: 'The interview invite email carries the candidate resume as an attachment.',
        release_date: '2026-03-04'
      },
      {
        feature_name: 'Candidate Name Addition',
        requested_change: "Inclusion of the candidate's name in the interview invite email subject line.",
        detailed_description:
          'The subject line of the interview invitation email should include the candidate name so panellists can identify the interview at a glance.',
        business_justification: 'Panellists with multiple interviews cannot distinguish invitations from the subject line.',
        current_behaviour: 'The subject line contains the interview slot only.',
        expected_behaviour: 'The subject line contains the candidate name along with the interview slot.',
        release_date: '2026-03-04'
      }
    ],
    actor
  );

  changeRequestsService.saveEfforts(
    cr01.id,
    [
      { category: 'DEVELOPMENT', hours: 16 },
      { category: 'TESTING', hours: 8 }
    ],
    actor
  );

  changeRequestsService.saveCosts(
    cr01.id,
    { billing_rate: 2000, currency: 'INR', discount_type: 'FIXED', discount_value: 48000, tax_percent: 0 },
    actor
  );

  changeRequestsService.saveAssumptions(cr01.id, ['Nil'], actor);
  changeRequestsService.saveDependencies(
    cr01.id,
    [{ dependency_type: 'CUSTOMER', text: 'Purchase order to be released by the customer before development starts.' }],
    actor
  );

  changeRequestsService.editHeader(
    cr01.id,
    {
      estimated_timeline: '2 Business Days from the PO release date',
      estimated_business_days: 2,
      target_release_date: '2026-03-04',
      planned_production_release: '2026-03-04',
      depends_on_po: 1,
      po_required: 1,
      payment_terms: '30 days from the date of invoice',
      invoice_terms: 'Invoice will be raised on completion of the change request deployment.'
    },
    actor
  );

  documentsService.generate(cr01.id, { format: getSetting('defaults.document_format', 'PDF'), final: false, actor, notes: 'Initial draft generated during seeding' });

  /* ---------------- A second account so the dashboard has shape ----------- */
  const acme = accountsService.create(
    {
      account: {
        account_name: 'Acme Technologies',
        account_code: 'ACMETECH',
        legal_entity_name: 'Acme Technologies Private Limited',
        customer_type: 'Mid-market',
        industry: 'Staffing & Recruitment',
        country: 'India',
        city: 'Bengaluru',
        state: 'Karnataka',
        status: 'ACTIVE',
        account_manager: 'Arun Satyan',
        cr_manager: 'Priya Menon',
        delivery_manager: 'Sahaf Ahammed',
        internal_approver_name: 'Arun Satyan',
        internal_approver_email: 'arun.satyan@hyreo.com'
      },
      msa: {
        msa_reference_number: 'ACMETECH-0001',
        msa_date: '2025-06-18',
        contract_start_date: '2025-07-01',
        contract_end_date: '2027-06-30',
        currency: 'INR',
        billing_entity: 'Hyreo Services India Private Limited',
        payment_terms: '45 days from the date of invoice',
        po_required: 0,
        status: 'ACTIVE'
      },
      primary_contact: { name: 'Meera Iyer', designation: 'Head of Talent Acquisition', email: 'meera.iyer@acmetech.example' },
      approval_contact: { name: 'Sanjay Rao', designation: 'CHRO', email: 'sanjay.rao@acmetech.example' }
    },
    adminActor
  );

  const demoCrs = [
    {
      title: 'Offer letter workflow automation',
      cr_type: 'NEW_FEATURE',
      priority: 'HIGH',
      cr_date: addDays(-52).slice(0, 10),
      items: [
        {
          feature_name: 'Offer approval routing',
          requested_change: 'Route offer letters through a two-step approval before release to the candidate.',
          release_date: addDays(-8).slice(0, 10)
        }
      ],
      efforts: [
        { category: 'DEVELOPMENT', hours: 40 },
        { category: 'TESTING', hours: 16 },
        { category: 'BUSINESS_ANALYSIS', hours: 8 }
      ],
      billing_rate: 2200,
      status: 'COMPLETED'
    },
    {
      title: 'Recruiter productivity dashboard',
      cr_type: 'REPORT_ANALYTICS',
      priority: 'MEDIUM',
      cr_date: addDays(-24).slice(0, 10),
      items: [
        {
          feature_name: 'Recruiter scorecard',
          requested_change: 'Weekly recruiter scorecard covering sourcing, screening and offer conversion.',
          release_date: addDays(14).slice(0, 10)
        }
      ],
      efforts: [
        { category: 'DEVELOPMENT', hours: 24 },
        { category: 'TESTING', hours: 10 }
      ],
      billing_rate: 2200,
      status: 'PENDING_INTERNAL_APPROVAL'
    },
    {
      title: 'SSO integration with corporate Azure AD',
      cr_type: 'INTEGRATION',
      priority: 'CRITICAL',
      cr_date: addDays(-9).slice(0, 10),
      items: [
        {
          feature_name: 'SAML single sign-on',
          requested_change: 'Enable SAML 2.0 single sign-on against the customer Azure AD tenant.',
          release_date: addDays(30).slice(0, 10)
        }
      ],
      efforts: [
        { category: 'DEVELOPMENT', hours: 32 },
        { category: 'TESTING', hours: 12 },
        { category: 'DEPLOYMENT', hours: 4 }
      ],
      billing_rate: 2200,
      status: 'DRAFT'
    }
  ];

  for (const demo of demoCrs) {
    const cr = changeRequestsService.create(
      {
        account_id: acme.id,
        title: demo.title,
        cr_date: demo.cr_date,
        cr_type: demo.cr_type,
        priority: demo.priority,
        requested_by: 'Meera Iyer'
      },
      actor
    );
    changeRequestsService.saveItems(cr.id, demo.items, actor);
    changeRequestsService.saveEfforts(cr.id, demo.efforts, actor);
    changeRequestsService.saveCosts(cr.id, { billing_rate: demo.billing_rate, currency: 'INR', tax_percent: 18 }, actor);
    changeRequestsService.editHeader(
      cr.id,
      { target_release_date: demo.items[0].release_date, estimated_business_days: 10 },
      actor
    );
    if (demo.status !== 'DRAFT') forceStatus(cr.id, demo.status, { actor, adminActor });
  }

  audit.record({
    entityType: 'SYSTEM',
    action: 'SEEDED',
    actor: { type: 'SYSTEM', name: 'System' },
    newValue: { accounts: 2, change_requests: 4, users: users.length }
  });

  return { seeded: true, accounts: 2, users: users.length };
}

/**
 * Demo helper: move a seeded change request to a later lifecycle state while
 * still writing the approval rows, documents and audit entries the real
 * workflow would have produced.
 */
function forceStatus(crId, status, { actor, adminActor }) {
  const cr = changeRequestsService.findRaw(crId);
  const approverEmail = cr.snapshot_internal_approver_email;

  transaction(() => {
    insert('change_request_approvals', {
      id: uid('APR'),
      cr_id: crId,
      level: 1,
      level_name: 'Internal Approval',
      approver_name: cr.snapshot_internal_approver,
      approver_email: approverEmail,
      status: status === 'PENDING_INTERNAL_APPROVAL' ? 'PENDING' : 'APPROVED',
      requested_at: addDays(-6),
      decided_at: status === 'PENDING_INTERNAL_APPROVAL' ? null : addDays(-5),
      decided_via: 'APP',
      revision: 0
    });

    // always land on the submitted state first — the closed-record trigger
    // refuses any further update once a CR reaches COMPLETED
    run("UPDATE change_requests SET status = 'PENDING_INTERNAL_APPROVAL', locked = 1, submitted_at = ?, submitted_by = ? WHERE id = ?", [
      addDays(-6),
      actor.id,
      crId
    ]);

    audit.record({
      entityType: 'CHANGE_REQUEST',
      entityId: crId,
      crId,
      action: ACTIONS.CR_SUBMITTED,
      actor,
      newValue: { seeded: true }
    });
  });

  if (status === 'COMPLETED') {
    const approvedAt = addDays(-5);
    run(
      `UPDATE change_requests
          SET internally_approved_at = ?, internally_approved_by = ?, shared_at = ?, customer_viewed_at = ?,
              customer_decided_at = ?, signed_at = ?, completed_at = ?, status = 'COMPLETED', locked = 1
        WHERE id = ?`,
      [approvedAt, adminActor.id, addDays(-4), addDays(-3), addDays(-2), addDays(-2), addDays(-2), crId]
    );

    insert('customer_approvals', {
      id: uid('CAP'),
      cr_id: crId,
      signer_order: 1,
      contact_name: 'Sanjay Rao',
      contact_email: 'sanjay.rao@acmetech.example',
      designation: 'CHRO',
      status: 'APPROVED',
      sent_at: addDays(-4),
      viewed_at: addDays(-3),
      decided_at: addDays(-2),
      signature_name: 'Sanjay Rao',
      signature_method: 'PORTAL',
      signed_at: addDays(-2)
    });

    audit.record({
      entityType: 'CHANGE_REQUEST',
      entityId: crId,
      crId,
      action: ACTIONS.CUSTOMER_SIGNED,
      actor: { type: 'CUSTOMER', name: 'Sanjay Rao' },
      newValue: { seeded: true }
    });
  }

  // documents are generated outside the transaction (file system writes)
  const isFinal = status !== 'PENDING_INTERNAL_APPROVAL';
  try {
    documentsService.generate(crId, { format: getSetting('defaults.document_format', 'PDF'), final: isFinal, actor: adminActor, notes: 'Seeded document' });
  } catch {
    /* document generation is best-effort during seeding */
  }
}

export function seed() {
  seedReferenceData();
  const users = seedUsers();
  const demo = seedDemoData();
  return { users: users.length, ...demo };
}

export default { seed, seedReferenceData, seedUsers, seedDemoData, isSeeded };
