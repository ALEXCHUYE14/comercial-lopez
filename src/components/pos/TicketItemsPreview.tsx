import { subLinea, type TicketLinea } from '@/utils/ticket'

export interface LineaPreview extends TicketLinea {
  key: string
  /** Nota solo para el personal (ej. equivalente descontado del stock): se
   * muestra como tooltip para no recargar el listado que ve el cliente. */
  nota?: string
}

/**
 * Listado de productos de la vista previa del ticket, con la misma
 * estructura que el ticket impreso (utils/ticket.ts): tabla de 3 columnas
 * alineadas CANT | DESCRIPCIÓN | IMPORTE, una fila por producto y una linea
 * secundaria solo cuando aporta informacion (ver subLinea).
 */
export function TicketItemsPreview({ lineas }: { lineas: LineaPreview[] }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b-[1.5px] border-black text-left text-[0.68rem] font-black tracking-wide">
          <th className="w-px whitespace-nowrap pb-1 pr-2.5">CANT</th>
          <th className="pb-1">DESCRIPCIÓN</th>
          <th className="w-px whitespace-nowrap pb-1 pl-2.5 text-right">IMPORTE</th>
        </tr>
      </thead>
      <tbody>
        {lineas.map((l) => {
          const sub = subLinea(l)
          return (
            <tr key={l.key} title={l.nota} className="align-top">
              <td className="tabular w-px whitespace-nowrap pr-2.5 pt-1.5">{l.cantidadTexto}</td>
              <td className="break-words pt-1.5 leading-snug">
                {l.nombre}
                {sub && <span className="block text-xs">{sub}</span>}
              </td>
              <td className="tabular w-px whitespace-nowrap pl-2.5 pt-1.5 text-right">{l.montoTexto}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
