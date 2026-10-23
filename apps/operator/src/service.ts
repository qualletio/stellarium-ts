import type { Database } from './db/database.js';
import { OrganizationService } from './organizations.js';
import { type PaymentPolicy, PaymentService } from './payments/paymentService.js';

export interface Service {
    organizations: OrganizationService;
    payments: PaymentService;
}

export function createService(db: Database, policy: PaymentPolicy): Service {
    const organizations = new OrganizationService(db);
    return {
        organizations,
        payments: new PaymentService(db, organizations, policy),
    };
}
