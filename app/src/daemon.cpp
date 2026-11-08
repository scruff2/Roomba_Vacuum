#include "daemon.h"

#include <QJSEngine>
#include <QJsonDocument>
#include <QNetworkReply>
#include <QNetworkRequest>

Daemon::Daemon(const QString &baseUrl, QObject *parent) : QObject(parent), m_base(baseUrl)
{
    m_retry.setSingleShot(true);
    m_retry.setInterval(3000);
    connect(&m_retry, &QTimer::timeout, this, &Daemon::connectEvents);

    // sweepd sends a keep-alive every 15 s; silence for longer means the
    // stream died without the socket noticing (suspend, network change).
    m_watchdog.setSingleShot(true);
    m_watchdog.setInterval(40000);
    connect(&m_watchdog, &QTimer::timeout, this, [this] {
        if (m_events)
            m_events->abort();
    });
}

void Daemon::start()
{
    connectEvents();
}

void Daemon::setOnline(bool online)
{
    if (online == m_online)
        return;
    m_online = online;
    emit onlineChanged();
}

void Daemon::connectEvents()
{
    if (m_events)
        return;
    m_parser.reset();
    QNetworkRequest request(QUrl(m_base + "/events"));
    request.setRawHeader("Accept", "text/event-stream");
    request.setAttribute(QNetworkRequest::CacheLoadControlAttribute, QNetworkRequest::AlwaysNetwork);
    request.setTransferTimeout(0);
    QNetworkReply *reply = m_net.get(request);
    m_events = reply;

    connect(reply, &QNetworkReply::readyRead, this, [this, reply] {
        m_watchdog.start();
        setOnline(true);
        for (const auto &event : m_parser.feed(reply->readAll()))
            handleEvent(event);
    });
    connect(reply, &QNetworkReply::finished, this, [this, reply] {
        reply->deleteLater();
        m_watchdog.stop();
        setOnline(false);
        m_retry.start();
    });
}

void Daemon::handleEvent(const SseParser::Event &event)
{
    const QVariant value = QJsonDocument::fromJson(event.data).toVariant();
    if (event.name == "status") {
        m_status = value.toMap();
        emit statusChanged();
    } else if (event.name == "mission") {
        emit missionUpdated(value.toMap());
    } else if (event.name == "log") {
        emit logAdded(value.toMap());
    }
}

void Daemon::get(const QString &path, const QJSValue &callback)
{
    QNetworkRequest request(QUrl(m_base + path));
    QNetworkReply *reply = m_net.get(request);
    connect(reply, &QNetworkReply::finished, this, [this, reply, callback] { finish(reply, callback); });
}

void Daemon::send(const QString &method, const QString &path, const QVariant &body, const QJSValue &callback)
{
    QNetworkRequest request(QUrl(m_base + path));
    request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    // sweepd refuses changes without this header, which keeps web pages from driving the robot.
    request.setRawHeader("X-Sweep", "1");
    // Settings wait for the robot to confirm, which can take several seconds.
    request.setTransferTimeout(30000);
    const QByteArray payload = body.isValid() ? QJsonDocument::fromVariant(body).toJson(QJsonDocument::Compact) : QByteArray();
    QNetworkReply *reply = m_net.sendCustomRequest(request, method.toUtf8(), payload);
    connect(reply, &QNetworkReply::finished, this, [this, reply, callback] { finish(reply, callback); });
}

void Daemon::command(const QString &name)
{
    QNetworkRequest request(QUrl(m_base + "/api/cmd/" + name));
    request.setRawHeader("X-Sweep", "1");
    QNetworkReply *reply = m_net.post(request, QByteArray());
    connect(reply, &QNetworkReply::finished, this, [this, reply, name] {
        reply->deleteLater();
        const QVariantMap data = QJsonDocument::fromJson(reply->readAll()).toVariant().toMap();
        if (reply->error() == QNetworkReply::NoError)
            emit notice(tr("Sent “%1”").arg(name), false);
        else
            emit notice(tr("Couldn't send “%1”: %2").arg(name, data.value("error", reply->errorString()).toString()), true);
    });
}

void Daemon::finish(QNetworkReply *reply, const QJSValue &callback)
{
    reply->deleteLater();
    const QByteArray bytes = reply->readAll();
    const bool ok = reply->error() == QNetworkReply::NoError;
    QVariant data = QJsonDocument::fromJson(bytes).toVariant();
    if (!ok && !data.toMap().contains("error"))
        data = QVariantMap{{"error", reply->errorString()}};
    if (!callback.isCallable() || !m_engine)
        return;
    QJSValue fn = callback;
    fn.call({QJSValue(ok), m_engine->toScriptValue(data)});
}
