#pragma once

#include <QJSValue>
#include <QNetworkAccessManager>
#include <QObject>
#include <QPointer>
#include <QTimer>
#include <QVariantMap>

#include "sseparser.h"

class QJSEngine;
class QNetworkReply;

// Client for sweepd, the background service that owns the robot connection.
// Keeps a live event stream open for status, and runs one-off API requests
// for the pages, handing results back to QML callbacks.
class Daemon : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool online READ online NOTIFY onlineChanged)
    Q_PROPERTY(QVariantMap status READ status NOTIFY statusChanged)
    Q_PROPERTY(QString baseUrl READ baseUrl CONSTANT)

public:
    explicit Daemon(const QString &baseUrl = QStringLiteral("http://127.0.0.1:8099"), QObject *parent = nullptr);

    void setEngine(QJSEngine *engine) { m_engine = engine; }
    void start();

    bool online() const { return m_online; }
    QVariantMap status() const { return m_status; }
    QString baseUrl() const { return m_base; }

    // callback(ok, data): data is the parsed JSON, or {error: "..."} when ok is false.
    Q_INVOKABLE void get(const QString &path, const QJSValue &callback = QJSValue());
    Q_INVOKABLE void send(const QString &method, const QString &path, const QVariant &body = QVariant(),
                          const QJSValue &callback = QJSValue());
    Q_INVOKABLE void command(const QString &name);

signals:
    void onlineChanged();
    void statusChanged();
    void missionUpdated(const QVariantMap &mission);
    void logAdded(const QVariantMap &entry);
    void notice(const QString &text, bool error);

private:
    void connectEvents();
    void handleEvent(const SseParser::Event &event);
    void setOnline(bool online);
    void finish(QNetworkReply *reply, const QJSValue &callback);

    QString m_base;
    QNetworkAccessManager m_net;
    QPointer<QNetworkReply> m_events;
    SseParser m_parser;
    QTimer m_retry;
    QTimer m_watchdog;
    QJSEngine *m_engine = nullptr;
    bool m_online = false;
    QVariantMap m_status;
};
