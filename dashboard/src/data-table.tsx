import { useState } from 'react';
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type Column, type ColumnDef, type OnChangeFn, type SortingState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type DataTableProps<T> = {
  data: T[];
  columns: ColumnDef<T>[];
  label: string;
  getRowId: (row: T) => string;
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  manualSorting?: boolean;
  busy?: boolean;
};

export function DataTable<T>({ data, columns, label, getRowId, sorting, onSortingChange, manualSorting = false, busy = false }: DataTableProps<T>) {
  const [localSorting, setLocalSorting] = useState<SortingState>([]);
  const table = useReactTable({
    data, columns, getRowId, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(),
    state: { sorting: sorting ?? localSorting }, onSortingChange: onSortingChange ?? setLocalSorting, manualSorting,
  });
  return <Table aria-label={label} aria-busy={busy} className="min-w-[640px]">
    <TableHeader>{table.getHeaderGroups().map(group => <TableRow key={group.id}>
      {group.headers.map(header => <TableHead key={header.id} style={{ width: header.getSize() }} aria-sort={header.column.getIsSorted() === 'asc' ? 'ascending' : header.column.getIsSorted() === 'desc' ? 'descending' : undefined}>
        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
      </TableHead>)}
    </TableRow>)}</TableHeader>
    <TableBody>{table.getRowModel().rows.map(row => <TableRow key={row.id}>
      {row.getVisibleCells().map(cell => <TableCell key={cell.id} className="py-2 align-top whitespace-normal">{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>)}
    </TableRow>)}</TableBody>
  </Table>;
}

export function SortHeading<T>({ column, children }: { column: Column<T>; children: React.ReactNode }) {
  const direction = column.getIsSorted();
  const Icon = direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ArrowUpDown;
  return <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={() => column.toggleSorting()}>
    {children}<Icon data-icon="inline-end" />
  </Button>;
}
