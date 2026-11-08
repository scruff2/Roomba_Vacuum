// sweep — a desktop control center for a Roomba, talking to the sweepd service.

#include <QGuiApplication>
#include <QIcon>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickStyle>
#include <QUrl>

#include "daemon.h"
#include "theme.h"
#include "translator.h"

int main(int argc, char *argv[]) {
    QGuiApplication app(argc, argv);
    app.setApplicationName("sweep");
    app.setApplicationVersion("0.1.0");

    // Matches the window to sweep.desktop, so the compositor (Wayland app_id)
    // and the launcher pick up the installed icon.
    app.setDesktopFileName("sweep");
    app.setWindowIcon(QIcon::fromTheme("sweep"));

    QQuickStyle::setStyle("Material");

    // Installed before anything is translated, and every qsTr() binding is
    // re-evaluated when the Omarchy language changes.
    Translator translator;
    app.installTranslator(&translator);

    Theme theme;
    Daemon daemon(qEnvironmentVariable("SWEEP_URL", "http://127.0.0.1:8099"));

    QQmlApplicationEngine engine;
    daemon.setEngine(&engine);
    QObject::connect(&translator, &Translator::changed, &engine, &QQmlEngine::retranslate);
    engine.rootContext()->setContextProperty("translator", &translator);
    engine.rootContext()->setContextProperty("theme", &theme);
    engine.rootContext()->setContextProperty("daemon", &daemon);
    engine.load(QUrl("qrc:/Main.qml"));
    if (engine.rootObjects().isEmpty())
        return 1;

    daemon.start();
    return app.exec();
}
