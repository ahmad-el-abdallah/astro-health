// TFT_eSPI configuration for this sketch.
//
// This can't just be a block of #defines at the top of astro_cyd.ino:
// TFT_eSPI.cpp is compiled as its OWN translation unit (part of the
// library), separately from the sketch, and never sees #defines written
// in a .ino file. TFT_eSPI.h specifically looks for a file named exactly
// `tft_setup.h` via `__has_include(<tft_setup.h>)`, searched on the
// compiler's include path -- and Arduino puts the sketch folder on that
// path for every file it compiles, library code included. That's what
// actually makes a sketch-local config apply everywhere consistently.
// (See TFT_eSPI.h, the comment above `#if __has_include(<tft_setup.h>)`.)
#define USER_SETUP_LOADED 1

// Lifeline's proven-working LovyanGFX config for this exact board uses a
// plain ILI9341 panel. If the screen is still wrong with this, try
// ILI9341_2_DRIVER instead (a TFT_eSPI alternative init sequence some
// ILI9341 clone panels need).
#define ILI9341_DRIVER

#define TFT_WIDTH  240
#define TFT_HEIGHT 320
#define TFT_MISO 12
#define TFT_MOSI 13
#define TFT_SCLK 14
#define TFT_CS    15
#define TFT_DC     2
#define TFT_RST   -1
#define TFT_BL    21
#define TFT_BACKLIGHT_ON HIGH

#define LOAD_GLCD
#define LOAD_FONT2
#define LOAD_FONT4
#define LOAD_FONT6
#define LOAD_FONT7
#define LOAD_FONT8
#define LOAD_GFXFF
#define SMOOTH_FONT

#define SPI_FREQUENCY       40000000
#define SPI_READ_FREQUENCY  16000000

// Lifeline's working LovyanGFX config uses SPI2_HOST (classic ESP32's
// "HSPI" peripheral) for the display, not the VSPI peripheral TFT_eSPI
// defaults to. Touch (astro_cyd.ino) uses VSPI instead, so the two don't
// fight over the same peripheral's GPIO-matrix routing.
#define USE_HSPI_PORT
