#pragma once

namespace Rml {

class Context {
public:
    void SetMediaQueryDimensions();
    void ClearMediaQueryDimensions();
    void GetMediaQueryDimensions();
    void SetTextScaleFactor();
    void GetTextScaleFactor();
    void SetFontRasterScale();
    void GetFontRasterScale();
};

} // namespace Rml
