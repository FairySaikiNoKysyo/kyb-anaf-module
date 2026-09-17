import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';

/**
 * Minimal in-memory stand-in for a TypeORM repository.
 *
 * The suite deliberately does not need Postgres: `npm test` has to run on a laptop, in
 * CI and on a reviewer's machine with nothing installed. Persistence itself is covered
 * by the migration, which is plain SQL.
 */
export function fakeRepository<T extends { id?: string }>(): Repository<T> & { rows: T[] } {
  const rows: T[] = [];

  const repo = {
    rows,
    create: (data: Partial<T>): T => ({ ...(data as T) }),
    save: async (entity: T): Promise<T> => {
      if (!entity.id) {
        entity.id = randomUUID();
        rows.push(entity);
      } else if (!rows.includes(entity)) {
        const idx = rows.findIndex((r) => r.id === entity.id);
        if (idx >= 0) rows[idx] = entity;
        else rows.push(entity);
      }
      return entity;
    },
    findOne: async ({ where }: { where: Record<string, unknown> }): Promise<T | null> => {
      const [[key, value]] = Object.entries(where);
      return rows.find((r) => (r as Record<string, unknown>)[key] === value) ?? null;
    },
    find: async ({ where }: { where?: Record<string, unknown> } = {}): Promise<T[]> => {
      if (!where) return [...rows];
      const [[key, value]] = Object.entries(where);
      return rows.filter((r) => (r as Record<string, unknown>)[key] === value);
    },
  };

  return repo as unknown as Repository<T> & { rows: T[] };
}
