QT += core gui network qml quick quickcontrols2

CONFIG += c++17 release
TARGET = sweep
TEMPLATE = app

HEADERS += \
    src/daemon.h \
    src/sseparser.h \
    src/theme.h \
    src/translator.h

SOURCES += \
    src/main.cpp \
    src/daemon.cpp \
    src/sseparser.cpp \
    src/theme.cpp \
    src/translator.cpp

RESOURCES += src/resources.qrc
