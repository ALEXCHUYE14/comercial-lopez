// Generador de etiquetas de precio/codigo de barras — para reimprimir la
// etiqueta de un producto (dañada, perdida, o que nunca tuvo una porque se
// repacó a granel). Reutiliza el mismo patron de ventana standalone que
// utils/ticket.ts (ver ese archivo para el porque) y se imprime en rollo de
// 58mm, el ancho mas comun de impresora termica economica en Peru — una
// etiqueta debajo de la otra, tantas veces como copias se pidan.
import { money, etiquetaUnidad } from '@/utils/format'
import { construirBarcodeSvg, esEan13Valido } from '@/utils/barcode'
import type { Producto } from '@/types/database'

/**
 * Arma el HTML de `copias` etiquetas del producto, una tras otra en una
 * tira de 58mm. Si el SKU no es un EAN-13 valido (12-13 digitos), la
 * etiqueta se imprime igual mostrando el SKU como texto grande en vez de un
 * codigo de barras dibujado — nunca se genera una barra "inventada" que
 * podria no leer bien en un escaner real.
 */
export function construirEtiquetasHtml(producto: Producto, copias: number): string {
  const conBarras = esEan13Valido(producto.sku)
  const svg = conBarras ? construirBarcodeSvg(producto.sku, { moduloAncho: 0.36, altoBarras: 13 }) : ''
  // Un producto a granel se cobra por unidad de medida (ej. S/ 4.80 POR kg,
  // no 4.80 el paquete completo) — sin el sufijo la etiqueta se leeria como
  // si fuera precio por pieza, como cualquier otro producto.
  const sufijoPrecio = producto.tipo_venta === 'granel' ? ` /${etiquetaUnidad(producto)}` : ''

  const unaEtiqueta = `
    <div class="etiqueta">
      <div class="nombre">${producto.nombre}</div>
      <div class="precio">${money(producto.precio_venta)}${sufijoPrecio}</div>
      <div class="codigo">
        ${conBarras ? svg : `<div class="sku-texto">${producto.sku}</div>`}
      </div>
    </div>`

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Etiqueta — ${producto.nombre}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body {
      font-family: 'Courier New', Courier, monospace;
      color: #000;
      background: #fff;
      width: 58mm;
    }
    .etiqueta {
      width: 58mm;
      padding: 3mm 2mm;
      text-align: center;
      page-break-after: always;
    }
    .etiqueta:last-child { page-break-after: auto; }
    .nombre {
      font-size: 10.5pt;
      font-weight: 700;
      line-height: 1.25;
      /* Maximo 2 lineas: un nombre largo no debe empujar el precio/codigo
         fuera de la etiqueta ni desbordar el ancho del rollo. */
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .precio {
      margin-top: 1.5mm;
      font-size: 15pt;
      font-weight: 900;
    }
    .codigo {
      margin-top: 2mm;
      display: flex;
      justify-content: center;
    }
    .sku-texto {
      font-size: 11pt;
      font-weight: 700;
      letter-spacing: 1px;
      border: 1.5px solid #000;
      padding: 1.5mm 3mm;
    }
    @page { size: 58mm auto; margin: 0; }
    @media print { body { width: 58mm; } }
  </style>
</head>
<body>
  ${Array.from({ length: Math.max(1, copias) }, () => unaEtiqueta).join('')}
</body>
</html>`
}
