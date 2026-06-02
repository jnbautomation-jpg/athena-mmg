// Shared inventory types.

/**
 * A vehicle scraped from CarGurus, before it is persisted.
 *
 * Mirrors the Prisma `Vehicle` model minus the database-managed fields
 * (`id`, `createdAt`, `updatedAt`) and relations (`posts`).
 */
export interface ScrapedVehicle {
  externalId: string; // CarGurus listing ID
  make: string;
  model: string;
  year: number;
  trim?: string | null;
  price: number;
  mileage: number;
  color?: string | null;
  description?: string | null;
  photoUrls: string[]; // array of image URLs scraped from CarGurus
  cargurusUrl: string;
  isActive: boolean;
  lastScrapedAt: Date;
}
