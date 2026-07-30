'use client';

import { formatBDT, type OrderDto } from '@foodhub/shared';

/**
 * The kitchen ticket, sized for an 80mm thermal roll.
 *
 * Bangladeshi kitchens run on paper, not screens — a cook with wet hands is not scrolling
 * a tablet. This prints through the browser rather than talking to the printer directly:
 * every thermal printer in the country already has a Windows driver, and asking a vendor
 * to install anything is where adoption stops.
 *
 * The layout is monospace and unstyled on purpose. Thermal printers render a fixed
 * character grid; anything that depends on colour, background or fine weight comes out as
 * a grey smear.
 */
export function KitchenTicket({ order, onClose }: { order: OrderDto; onClose: () => void }) {
  return (
    <>
      {/*
        Print CSS lives here rather than in the global sheet so nothing else on the page
        has to know about printing. `@page` at 80mm with no margin is what stops the
        driver scaling the ticket down to fit an imaginary A4 sheet.
      */}
      <style>{`
        @media print {
          body > * { display: none !important; }
          #kot-print, #kot-print * { display: block !important; }
          #kot-print {
            position: absolute !important;
            inset: 0 !important;
            padding: 0 !important;
            background: #fff !important;
            color: #000 !important;
          }
          @page { size: 80mm auto; margin: 3mm; }
        }
      `}</style>

      <div className="fixed inset-0 z-50 flex items-center justify-center print:static">
        <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40 print:hidden" />

        <div className="relative w-full max-w-sm rounded-2xl bg-white p-4 shadow-2xl print:max-w-none print:rounded-none print:shadow-none">
          <div id="kot-print" className="font-mono text-[13px] leading-[1.45] text-black">
            <div className="text-center">
              <div className="text-[15px] font-bold">{order.tenantName ?? 'KITCHEN'}</div>
              <div className="text-[20px] font-bold tracking-wider">{order.code}</div>
              <div>{new Date(order.placedAt).toLocaleString('en-GB', { hour12: false })}</div>
              {order.scheduledFor && (
                <div className="mt-1 text-[15px] font-bold">
                  FOR {new Date(order.scheduledFor).toLocaleString('en-GB', { hour12: false })}
                </div>
              )}
              <div className="mt-1 text-[15px] font-bold">
                {order.fulfillment === 'PICKUP' ? '*** PICKUP ***' : 'DELIVERY'}
              </div>
            </div>

            <div className="my-2">{'='.repeat(32)}</div>

            {order.items.map((item) => (
              <div key={item.id} className="mb-1.5">
                <div className="font-bold">
                  {item.qty} x {item.nameSnapshot}
                </div>
                {/* Modifiers are the whole reason a printed ticket beats a shouted one. */}
                {item.modifiers?.map((m, i) => (
                  <div key={i} className="pl-4">- {m.optionName}</div>
                ))}
                {item.comboName && <div className="pl-4">[{item.comboName}]</div>}
              </div>
            ))}

            {order.deliveryAddress.note && (
              <>
                <div className="my-2">{'-'.repeat(32)}</div>
                <div className="font-bold">NOTE: {order.deliveryAddress.note}</div>
              </>
            )}

            <div className="my-2">{'='.repeat(32)}</div>

            <div>{order.deliveryAddress.name} — {order.deliveryAddress.phone}</div>
            {order.fulfillment !== 'PICKUP' && (
              <div>{order.deliveryAddress.addressLine}, {order.deliveryAddress.area}</div>
            )}

            <div className="my-2">{'-'.repeat(32)}</div>

            <div className="flex justify-between"><span>Total</span><span>{formatBDT(order.total)}</span></div>
            {/* The number the rider actually has to collect, in the largest type on the
                ticket — this is the line that gets misread on a doorstep. */}
            {order.dueOnDelivery > 0 && order.advanceAmount > 0 && (
              <div className="mt-1 text-[16px] font-bold">
                COLLECT {formatBDT(order.dueOnDelivery)}
              </div>
            )}
            {order.dueOnDelivery === 0 && <div className="mt-1 font-bold">PAID IN FULL</div>}
          </div>

          <div className="mt-4 flex gap-2 print:hidden">
            <button onClick={onClose} className="btn-ghost h-11 min-h-0 flex-1 text-sm">Close</button>
            <button onClick={() => window.print()} className="btn-brand h-11 min-h-0 flex-1 text-sm">
              Print
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
