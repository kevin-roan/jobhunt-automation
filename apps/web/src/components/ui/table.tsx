import * as React from 'react';
import { cn } from '@/lib/utils';

export const TableWrapper = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'scrollbar-thin w-full overflow-x-auto rounded-lg border border-border bg-card',
      className,
    )}
    {...props}
  />
);

export const Table = ({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) => (
  <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
);

export const THead = ({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) => (
  <thead className={cn('border-b border-border bg-secondary/40', className)} {...props} />
);

export const TBody = ({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) => (
  <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />
);

export const TR = ({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) => (
  <tr
    className={cn('border-b border-border transition-colors hover:bg-secondary/40', className)}
    {...props}
  />
);

export const TH = ({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
  <th
    className={cn(
      'h-9 whitespace-nowrap px-3 text-left align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
      className,
    )}
    {...props}
  />
);

export const TD = ({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cn('px-3 py-2.5 align-middle', className)} {...props} />
);

export interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}

export const Pagination = ({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
}: PaginationProps) => {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1 py-3 text-xs text-muted-foreground">
      <span className="tabular">
        {from}–{to} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded-md border border-border px-2.5 py-1 transition-colors hover:bg-secondary disabled:opacity-40"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >
          Previous
        </button>
        <span className="tabular">
          Page {page} of {Math.max(1, totalPages)}
        </span>
        <button
          type="button"
          className="rounded-md border border-border px-2.5 py-1 transition-colors hover:bg-secondary disabled:opacity-40"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
        >
          Next
        </button>
      </div>
    </div>
  );
};
