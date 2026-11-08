package com.agenticsmith.pdfview

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** A PDF drawn with the system PdfRenderer; Android's WebView cannot show one. */
class AgenticSmithPdfViewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AgenticSmithPdfView")

    View(AgenticSmithPdfView::class) {
      Events("onLoadError")
      Prop("uri") { view: AgenticSmithPdfView, uri: String -> view.load(uri) }
      OnViewDestroys { view: AgenticSmithPdfView -> view.release() }
    }
  }
}
