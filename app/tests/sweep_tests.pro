QT += core gui network quick quickcontrols2 testlib
CONFIG += c++17 testcase
TARGET = sweep_tests
TEMPLATE = app

INCLUDEPATH += ../src

HEADERS += ../src/sseparser.h ../src/theme.h ../src/translator.h
SOURCES += sweep_tests.cpp ../src/sseparser.cpp ../src/theme.cpp ../src/translator.cpp
